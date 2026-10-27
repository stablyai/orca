import { extractExecError, ghExecFileAsync, gitExecFileAsync } from './runner'
import { parseHostedRemote } from './hosted-remote-url'
import { resolveDefaultBaseRefViaExec } from './repo'

const EXPLICIT_USERNAME_CONFIG_KEYS = ['github.user', 'user.username'] as const

const GH_LOGIN_PROBE_TIMEOUT_MS = 2500
// Allow all three 2.5s probes plus 1.25s backoff; cap longer Retry-After waits and stuck cleanup.
const GH_LOGIN_PROBE_WALL_MS = 10_000
// Timeout proves nothing about the login; retry after a cooldown instead of caching failure forever.
const GH_LOGIN_TIMEOUT_RETRY_MS = 5 * 60 * 1000
const LOCAL_GIT_READ_TIMEOUT_MS = 5000

export function normalizeGitUsername(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) {
    return ''
  }

  const localPart = trimmed.includes('@') ? trimmed.split('@')[0] : trimmed
  return localPart.replace(/^\d+\+/, '')
}

/** Reject failed API JSON/multiline output before it can become a branch prefix. */
export function isPlausibleHostedLogin(value: string): boolean {
  // Preserve GitHub's length/separator limits while allowing the EMU _shortcode suffix.
  return (
    /^[A-Za-z0-9]$/.test(value) ||
    (/^[A-Za-z0-9][A-Za-z0-9_-]{0,37}[A-Za-z0-9]$/.test(value) && !value.includes('--'))
  )
}

// A login occupies one loose-ref filename; ASCII length equals the 255-byte filesystem limit.
const MAX_BRANCH_SAFE_LOGIN_LENGTH = 255

/** Configured logins accept provider-specific characters and lengths beyond GitHub's rules. */
export function isBranchSafeHostedLogin(value: string): boolean {
  if (value.length > MAX_BRANCH_SAFE_LOGIN_LENGTH) {
    return false
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    return false
  }
  // Dot placements git check-ref-format rejects; `.lock` is case-sensitive there too.
  return !value.includes('..') && !value.endsWith('.') && !value.endsWith('.lock')
}

function normalizeHostedLogin(value: string): string {
  const normalized = normalizeGitUsername(value)
  return normalized && isPlausibleHostedLogin(normalized) ? normalized : ''
}

/** Explicit `github.user`/`user.username` config is provider-agnostic; only reject non-tokens. */
function normalizeConfiguredLogin(value: string): string {
  const normalized = normalizeGitUsername(value)
  return normalized && isBranchSafeHostedLogin(normalized) ? normalized : ''
}

/** Unknown empty logins preserve persisted values; authoritative empty logins clear them. */
export type ResolvedGitUsername = { username: string; authoritative: boolean }

type GhLoginProbeResult = { stdout: string; stderr: string; timedOut: boolean }
type GhLoginOutcome = { login: string; timedOut: boolean }

// Share gh login results across repos; timeouts use a retry timestamp instead of permanent caching.
let cachedGhLogin: string | null = null
let ghLoginTimedOutAt: number | null = null
let ghLoginProbeInFlight: Promise<GhLoginOutcome> | null = null

function isExecTimeoutError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false
  }
  const { code, killed, signal } = err as { code?: unknown; killed?: unknown; signal?: unknown }
  // Windows timeout kills can report killed/SIGTERM with no ETIMEDOUT code.
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
      // Partially authenticated gh can return login details on stderr even with a nonzero exit.
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

// Parse account blocks so the Active account marker selects its own login.
function parseGhAuthStatusLogin(output: string): string {
  let currentLogin = ''
  let firstLogin = ''
  for (const line of output.split('\n')) {
    const login = line.match(/Logged in to github\.com account\s+([A-Za-z0-9][A-Za-z0-9_-]*)/)?.[1]
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
  const apiLogin = normalizeHostedLogin(api.stdout)
  if (apiLogin) {
    return { login: apiLogin, timedOut: false }
  }
  if (api.timedOut) {
    // Avoid a second stuck keychain/network probe after the API probe times out.
    return { login: '', timedOut: true }
  }
  const status = await runGhLoginProbe(['auth', 'status'])
  if (status.timedOut) {
    return { login: '', timedOut: true }
  }
  const output = `${status.stdout}\n${status.stderr}`
  return { login: normalizeHostedLogin(parseGhAuthStatusLogin(output)), timedOut: false }
}

async function getGhLoginOutcome(): Promise<GhLoginOutcome> {
  if (cachedGhLogin !== null) {
    return { login: cachedGhLogin, timedOut: false }
  }
  if (ghLoginTimedOutAt !== null && Date.now() - ghLoginTimedOutAt < GH_LOGIN_TIMEOUT_RETRY_MS) {
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

/** Only the effective remote may authorize a GitHub prefix; a secondary GitHub mirror must not. */
async function localRepoHasEffectiveGitHubRemote(repoPath: string): Promise<boolean> {
  const remoteList = await gitExecFileAsync(['remote'], {
    cwd: repoPath,
    timeout: LOCAL_GIT_READ_TIMEOUT_MS
  }).catch(() => null)
  const remotes = (remoteList?.stdout.trim() ?? '').split('\n').filter(Boolean)
  // Only a successful empty list proves there is no hosted remote to inspect.
  if (remoteList && remotes.length === 0) {
    return false
  }
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

/** Resolve explicit config, effective GitHub login, then safe author name; unknown returns non-authoritative empty. */
export async function resolveLocalGitUsernameDetailed(
  repoPath: string
): Promise<ResolvedGitUsername> {
  for (const key of EXPLICIT_USERNAME_CONFIG_KEYS) {
    try {
      const { stdout } = await gitExecFileAsync(['config', '--get', key], {
        cwd: repoPath,
        timeout: LOCAL_GIT_READ_TIMEOUT_MS
      })
      const username = normalizeConfiguredLogin(stdout)
      if (username) {
        return { username, authoritative: true }
      }
    } catch {}
  }
  if (await localRepoHasEffectiveGitHubRemote(repoPath)) {
    const outcome = await getGhLoginOutcome()
    if (outcome.login || outcome.timedOut) {
      return { username: outcome.login, authoritative: !outcome.timedOut }
    }
  }
  const authorName = (await readGitStdout(repoPath, ['config', '--get', 'user.name'])).trim()
  if (isBranchSafeHostedLogin(authorName)) {
    return { username: authorName, authoritative: true }
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
