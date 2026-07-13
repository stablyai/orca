import type { SshGitProvider } from '../providers/ssh-git-provider'
import { extractExecError, ghExecFileAsync, gitExecFileAsync } from './runner'
import { parseHostedRemote } from './hosted-remote-url'
import { resolveDefaultBaseRefViaExec } from './repo'

const EXPLICIT_USERNAME_CONFIG_KEYS = ['github.user', 'user.username'] as const

const GH_LOGIN_PROBE_TIMEOUT_MS = 2500
// Why: a timeout-killed gh can leave a grandchild holding the stdio pipes, so
// the exec promise may settle long after the kill. The wall keeps the resolver
// on schedule either way (issue #7225: a hung gh froze startup for 127s). It
// must exceed ghExecFileAsync's full worst-case envelope — 3 attempts ×
// GH_LOGIN_PROBE_TIMEOUT_MS plus its transient-retry backoff sleeps (250ms +
// 1000ms ≈ 8.75s total) — or a slow-but-recovering gh would be misread as
// stuck and start the retry cooldown. Retry-After sleeps can exceed any wall;
// bounding those is exactly what the wall is for.
const GH_LOGIN_PROBE_WALL_MS = 10_000
// Why: a timed-out probe says nothing about the account, so don't pin '' for
// the whole session — retry after a cooldown instead of hammering a stuck gh.
export const LOCAL_GIT_USERNAME_TIMEOUT_RETRY_MS = 5 * 60 * 1000
const LOCAL_GIT_READ_TIMEOUT_MS = 5000

export function normalizeGitUsername(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) {
    return ''
  }

  const localPart = trimmed.includes('@') ? trimmed.split('@')[0] : trimmed
  return localPart.replace(/^\d+\+/, '')
}

/**
 * A resolved username plus whether every probe on the way to it completed.
 * Non-authoritative '' (a probe timed out) must not overwrite a previously
 * persisted username; authoritative '' should clear one.
 */
export type ResolvedGitUsername = { username: string; authoritative: boolean }

export async function getSshGitUsername(
  provider: SshGitProvider,
  repoPath: string
): Promise<string> {
  // Why: SSH targets cannot rely on the local `gh` account, and git email/name
  // are author identity rather than hosted-account usernames.
  for (const key of EXPLICIT_USERNAME_CONFIG_KEYS) {
    try {
      const { stdout } = await provider.exec(['config', '--get', key], repoPath)
      const username = normalizeGitUsername(stdout)
      if (username) {
        return username
      }
    } catch {
      // Missing config keys are expected; try the next explicit username key.
    }
  }
  return ''
}

type GhLoginProbeResult = { stdout: string; stderr: string; timedOut: boolean }
type GhLoginOutcome = { login: string; timedOut: boolean }

// gh reports one account for the whole machine, so the login is cached
// per-process rather than per-repo (mirrors the old sync cache). Timed-out
// probes use the soft retry timestamp instead of the permanent cache.
let cachedGhLogin: string | null = null
let ghLoginTimedOutAt: number | null = null
let ghLoginProbeInFlight: Promise<GhLoginOutcome> | null = null

function isExecTimeoutError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false
  }
  const { code, killed, signal } = err as { code?: unknown; killed?: unknown; signal?: unknown }
  // Why: on Windows a timeout kill surfaces as killed/SIGTERM with a null
  // code, not ETIMEDOUT — the old ETIMEDOUT-only check let a stuck first
  // probe fall through to a second equally stuck probe (issue #7225).
  return code === 'ETIMEDOUT' || killed === true || signal === 'SIGTERM'
}

async function runGhLoginProbe(args: string[]): Promise<GhLoginProbeResult> {
  let wallTimer: ReturnType<typeof setTimeout> | undefined
  const wall = new Promise<GhLoginProbeResult>((resolve) => {
    wallTimer = setTimeout(
      () => resolve({ stdout: '', stderr: '', timedOut: true }),
      GH_LOGIN_PROBE_WALL_MS
    )
    wallTimer.unref?.()
  })
  const exec = ghExecFileAsync(args, { timeout: GH_LOGIN_PROBE_TIMEOUT_MS }).then(
    ({ stdout, stderr }) => ({ stdout, stderr, timedOut: false }),
    (err: unknown) => {
      // Why: `gh auth status` reports the login on stderr with a non-zero
      // exit when partially authenticated, so failures still carry output.
      const { stdout, stderr } = extractExecError(err)
      return { stdout, stderr, timedOut: isExecTimeoutError(err) }
    }
  )
  try {
    return await Promise.race([exec, wall])
  } finally {
    if (wallTimer) {
      clearTimeout(wallTimer)
    }
  }
}

// Why: `gh auth status` prints one block per account — the login line first,
// then `Active account: true/false`. Parse block-wise so a multi-account
// output resolves the ACTIVE account instead of whatever login line happens
// to follow the first `Active account: true` marker.
function parseGhAuthStatusLogin(output: string): string {
  let currentLogin = ''
  let firstLogin = ''
  for (const line of output.split('\n')) {
    const login = line.match(/Logged in to github\.com account\s+([A-Za-z0-9-]+)/)?.[1]
    if (login) {
      currentLogin = login
      if (!firstLogin) {
        firstLogin = login
      }
      continue
    }
    if (/Active account:\s+true/.test(line) && currentLogin) {
      return currentLogin
    }
  }
  return firstLogin
}

async function probeGhLoginOnce(): Promise<GhLoginOutcome> {
  const api = await runGhLoginProbe(['api', 'user', '-q', '.login'])
  const apiLogin = normalizeGitUsername(api.stdout.trim())
  if (apiLogin) {
    return { login: apiLogin, timedOut: false }
  }
  if (api.timedOut) {
    // Why: if `gh api user` timed out, `gh auth status` is likely to hit the
    // same stuck keychain/network path. Keep resolution bounded to one probe.
    return { login: '', timedOut: true }
  }
  const status = await runGhLoginProbe(['auth', 'status'])
  if (status.timedOut) {
    return { login: '', timedOut: true }
  }
  const output = `${status.stdout}\n${status.stderr}`
  return { login: normalizeGitUsername(parseGhAuthStatusLogin(output)), timedOut: false }
}

async function getGhLoginOutcome(): Promise<GhLoginOutcome> {
  if (cachedGhLogin !== null) {
    return { login: cachedGhLogin, timedOut: false }
  }
  if (
    ghLoginTimedOutAt !== null &&
    Date.now() - ghLoginTimedOutAt < LOCAL_GIT_USERNAME_TIMEOUT_RETRY_MS
  ) {
    return { login: '', timedOut: true }
  }
  if (ghLoginProbeInFlight) {
    return ghLoginProbeInFlight
  }
  const probe = probeGhLoginOnce()
    .then((outcome) => {
      if (outcome.timedOut) {
        ghLoginTimedOutAt = Date.now()
      } else {
        cachedGhLogin = outcome.login
        ghLoginTimedOutAt = null
      }
      return outcome
    })
    .finally(() => {
      ghLoginProbeInFlight = null
    })
  ghLoginProbeInFlight = probe
  return probe
}

/**
 * Resolve the `gh` CLI's GitHub login without ever blocking the caller for
 * longer than the probe wall. Never rejects; unknown resolves to ''.
 */
export async function getGhLoginAsync(): Promise<string> {
  return (await getGhLoginOutcome()).login
}

async function readGitStdout(repoPath: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await gitExecFileAsync(args, {
      cwd: repoPath,
      timeout: LOCAL_GIT_READ_TIMEOUT_MS
    })
    return stdout.trim()
  } catch {
    return ''
  }
}

function getRemoteNameFromRef(shortRef: string, remotes: readonly string[]): string {
  const sortedRemotes = [...remotes].sort((a, b) => b.length - a.length)
  return sortedRemotes.find((remote) => shortRef.startsWith(`${remote}/`)) ?? ''
}

function getDefaultBranchName(shortRef: string, remoteName: string): string {
  if (!shortRef.includes('/')) {
    return shortRef
  }
  return remoteName ? shortRef.slice(remoteName.length + 1) : shortRef.split('/').slice(1).join('/')
}

async function getConfiguredBranchRemote(repoPath: string, branch: string | null): Promise<string> {
  if (!branch) {
    return ''
  }
  const remote = await readGitStdout(repoPath, ['config', '--get', `branch.${branch}.remote`])
  return remote === '.' ? '' : remote
}

/**
 * Faithful async port of the old candidate-ordered GitHub gate: only the
 * repo's *effective* remote (current-branch remote, default-branch remote,
 * default-base remote, origin, or a lone remote) may authorize the gh login.
 * Why: a GitLab-primary repo with a secondary GitHub mirror must NOT pick up
 * the GitHub account name as its branch prefix.
 */
async function localRepoHasEffectiveGitHubRemote(repoPath: string): Promise<boolean> {
  const remotes = (await readGitStdout(repoPath, ['remote'])).split('\n').filter(Boolean)
  const defaultBaseRef = await resolveDefaultBaseRefViaExec((argv) =>
    gitExecFileAsync(argv, { cwd: repoPath, timeout: LOCAL_GIT_READ_TIMEOUT_MS })
  )
  const defaultBaseRemote = defaultBaseRef ? getRemoteNameFromRef(defaultBaseRef, remotes) : ''
  const defaultBranch = defaultBaseRef
    ? getDefaultBranchName(defaultBaseRef, defaultBaseRemote)
    : null

  const currentBranch = await readGitStdout(repoPath, ['branch', '--show-current'])
  const candidateRemotes = [
    await getConfiguredBranchRemote(repoPath, currentBranch || null),
    await getConfiguredBranchRemote(repoPath, defaultBranch),
    defaultBaseRemote,
    'origin',
    remotes.length === 1 ? remotes[0] : ''
  ]

  const seen = new Set<string>()
  for (const remote of candidateRemotes) {
    if (!remote || seen.has(remote)) {
      continue
    }
    seen.add(remote)
    const remoteUrl = await readGitStdout(repoPath, ['remote', 'get-url', remote])
    if (remoteUrl && parseHostedRemote(remoteUrl)?.provider === 'github') {
      return true
    }
  }
  return false
}

/**
 * Async replacement for the old sync `getGitUsername`: explicit config keys
 * first, then the `gh` login — but only for repos whose effective remote is
 * GitHub, since a GitHub account name would be the wrong branch prefix for
 * GitLab/Bitbucket/self-hosted repos. Never rejects; unknown resolves to
 * { username: '', authoritative: false }.
 */
export async function resolveLocalGitUsernameDetailed(
  repoPath: string
): Promise<ResolvedGitUsername> {
  for (const key of EXPLICIT_USERNAME_CONFIG_KEYS) {
    try {
      const { stdout } = await gitExecFileAsync(['config', '--get', key], {
        cwd: repoPath,
        timeout: LOCAL_GIT_READ_TIMEOUT_MS
      })
      const username = normalizeGitUsername(stdout)
      if (username) {
        return { username, authoritative: true }
      }
    } catch {
      // Missing config keys are expected; try the next explicit username key.
    }
  }
  if (await localRepoHasEffectiveGitHubRemote(repoPath)) {
    const outcome = await getGhLoginOutcome()
    return { username: outcome.login, authoritative: !outcome.timedOut }
  }
  return { username: '', authoritative: true }
}

export async function resolveLocalGitUsername(repoPath: string): Promise<string> {
  return (await resolveLocalGitUsernameDetailed(repoPath)).username
}

export function resetGhLoginCacheForTests(): void {
  cachedGhLogin = null
  ghLoginTimedOutAt = null
  ghLoginProbeInFlight = null
}
