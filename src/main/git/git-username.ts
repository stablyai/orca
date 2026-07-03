import type { SshGitProvider } from '../providers/ssh-git-provider'
import { extractExecError, ghExecFileAsync, gitExecFileAsync } from './runner'
import { parseHostedRemote } from './hosted-remote-url'

const EXPLICIT_USERNAME_CONFIG_KEYS = ['github.user', 'user.username'] as const

const GH_LOGIN_PROBE_TIMEOUT_MS = 2500
// Why: a timeout-killed gh can leave a grandchild holding the stdio pipes, so
// the exec promise may settle long after the kill. The wall keeps the resolver
// on schedule either way (issue #7225: a hung gh froze startup for 127s).
const GH_LOGIN_PROBE_WALL_MS = GH_LOGIN_PROBE_TIMEOUT_MS + 500
const LOCAL_GIT_READ_TIMEOUT_MS = 5000

export function normalizeGitUsername(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) {
    return ''
  }

  const localPart = trimmed.includes('@') ? trimmed.split('@')[0] : trimmed
  return localPart.replace(/^\d+\+/, '')
}

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

// gh reports one account for the whole machine, so the login is cached
// per-process rather than per-repo (mirrors the old sync cache).
let cachedGhLogin: string | null = null
let ghLoginProbeInFlight: Promise<string> | null = null

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

/**
 * Resolve the `gh` CLI's GitHub login without ever blocking the caller for
 * longer than the probe wall. Never rejects; unknown resolves to ''.
 */
export async function getGhLoginAsync(): Promise<string> {
  if (cachedGhLogin !== null) {
    return cachedGhLogin
  }
  if (ghLoginProbeInFlight) {
    return ghLoginProbeInFlight
  }
  const probe = (async () => {
    const api = await runGhLoginProbe(['api', 'user', '-q', '.login'])
    const apiLogin = normalizeGitUsername(api.stdout.trim())
    if (apiLogin) {
      return apiLogin
    }
    if (api.timedOut) {
      // Why: if `gh api user` timed out, `gh auth status` is likely to hit the
      // same stuck keychain/network path. Keep resolution bounded to one probe.
      return ''
    }
    const status = await runGhLoginProbe(['auth', 'status'])
    const output = `${status.stdout}\n${status.stderr}`
    const activeAccountMatch = output.match(
      /Active account:\s+true[\s\S]*?account\s+([A-Za-z0-9-]+)/
    )
    if (activeAccountMatch?.[1]) {
      return normalizeGitUsername(activeAccountMatch[1])
    }
    const accountMatch = output.match(/Logged in to github\.com account\s+([A-Za-z0-9-]+)/)
    return normalizeGitUsername(accountMatch?.[1] ?? '')
  })()
    .then((login) => {
      cachedGhLogin = login
      return login
    })
    .finally(() => {
      ghLoginProbeInFlight = null
    })
  ghLoginProbeInFlight = probe
  return probe
}

async function localRepoHasGitHubRemote(repoPath: string): Promise<boolean> {
  try {
    const { stdout } = await gitExecFileAsync(['remote', '-v'], {
      cwd: repoPath,
      timeout: LOCAL_GIT_READ_TIMEOUT_MS
    })
    return stdout.split('\n').some((line) => {
      const url = line.split(/\s+/)[1]
      return !!url && parseHostedRemote(url)?.provider === 'github'
    })
  } catch {
    return false
  }
}

/**
 * Async replacement for the old sync `getGitUsername`: explicit config keys
 * first, then the `gh` login — but only for repos with a GitHub remote, since
 * a GitHub account name would be the wrong branch prefix for GitLab/Bitbucket/
 * self-hosted repos. Never rejects; unknown resolves to ''.
 */
export async function resolveLocalGitUsername(repoPath: string): Promise<string> {
  for (const key of EXPLICIT_USERNAME_CONFIG_KEYS) {
    try {
      const { stdout } = await gitExecFileAsync(['config', '--get', key], {
        cwd: repoPath,
        timeout: LOCAL_GIT_READ_TIMEOUT_MS
      })
      const username = normalizeGitUsername(stdout)
      if (username) {
        return username
      }
    } catch {
      // Missing config keys are expected; try the next explicit username key.
    }
  }
  if (await localRepoHasGitHubRemote(repoPath)) {
    return getGhLoginAsync()
  }
  return ''
}

export function resetGhLoginCacheForTests(): void {
  cachedGhLogin = null
  ghLoginProbeInFlight = null
}
