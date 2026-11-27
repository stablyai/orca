// Runtime preflight must stay independent of ipcMain registration.
import type {
  PathSource,
  ShellHydrationFailureReason
} from '../../shared/shell/launch/shell-path-hydration-types'
import {
  hydrateShellPath,
  mergePathSegments
} from '../startup/shell-environment/hydrate-shell-path'
import { getAzureDevOpsAuthStatus } from '../azure-devops/client'
import { getBitbucketAuthStatus } from '../bitbucket/client'
import { getGiteaAuthStatus } from '../gitea/client'
import { _resetKnownHostsCache } from '../gitlab/projects/gitlab-known-host-probe'
import { mergePersistedWindowsPathAsync } from '../pty/environment/windows-environment-path'
import type { WslPreflightTarget } from '../ipc/preflight/preflight-wsl-agent-detection'
import {
  getPreflightWslTarget,
  type PreflightRuntimeContext
} from '../ipc/preflight/preflight-runtime-target'

export type { PreflightRuntimeContext }
import { hydrateShellPathForAgentDetection } from '../ipc/command-path/agent-detection-shell-path'
import {
  execCommandInWslOrThrow,
  execLocalPreflightCommandOrThrow
} from '../ipc/preflight/preflight-command-exec'
import {
  detectCommandRuntime,
  detectDefaultWslGlab,
  isWindowsHostDefault,
  type CommandRuntime
} from './preflight-command-runtime'
import { buildLocalPreflightEnv } from '../ipc/preflight/preflight-local-env'
import { withConfiguredProxyEnv } from '../network/configured-proxy-child-env'
import { quotePosixShell } from '../../shared/shell/launch/shell-argument-quoting'
import {
  detectRemoteWindowsTerminalCapabilities,
  type RemoteWindowsTerminalCapabilities
} from '../ipc/preflight/preflight-remote-windows-terminal-capabilities'
import { invalidateWslGuestEnvironment } from '../wsl/execution/wsl-guest-environment'
import { prunePreflightWslCache } from '../wsl/discovery/preflight-wsl-cache'
import { assertWslDistroRunningForExec } from '../wsl/discovery/wsl-background-exec-gate'
import { deferUntilWslDistroRunning } from '../wsl/discovery/wsl-background-distro-gate'
import {
  detectInstalledAgents,
  type InstalledAgentDetectionOptions
} from './installed-agent-detection'
export { detectAgentCommandsOnHost } from './agent-command-detection'
export {
  detectInstalledAgents,
  detectInstalledAgentsWithShellPathHydration
} from './installed-agent-detection'

export type PreflightStatus = {
  git: { installed: boolean }
  gh: { installed: boolean; authenticated: boolean }
  // Optional for older git/gh-only clients; GitLab consumers gate on authenticated.
  glab?: { installed: boolean; authenticated: boolean }
  bitbucket?: { configured: boolean; authenticated: boolean; account: string | null }
  azureDevOps?: {
    configured: boolean
    authenticated: boolean
    account: string | null
    baseUrl: string | null
    tokenConfigured: boolean
  }
  gitea?: {
    configured: boolean
    authenticated: boolean
    account: string | null
    baseUrl: string | null
    tokenConfigured: boolean
  }
}

export { detectRemoteWindowsTerminalCapabilities }
export type { RemoteWindowsTerminalCapabilities }

// Collapse repeated Landing probes within an app session.
let cached: PreflightStatus | null = null
// Cache per distro; a short TTL recovers unreachable distros whose failures appear as missing tooling.
const WSL_PREFLIGHT_CACHE_TTL_MS = 30_000
const MAX_WSL_PREFLIGHT_DISTRO_ENTRIES = 128
const cachedByRuntime = new Map<string, { result: PreflightStatus; expiresAt: number }>()
/** `refusedWslDistro`: the default distro was stopped, so its glab answer waits for it to run. */
type PreflightExecution = { status: PreflightStatus; refusedWslDistro?: string }
const preflightInFlight = new Map<string, Promise<PreflightExecution>>()

// Per-key generations and reset epochs prevent older probes repopulating refreshed/cleared caches.
const latestPreflightRun = new Map<string, number>()
let preflightRunCounter = 0
let preflightCacheEpoch = 0

const LOCAL_PREFLIGHT_CACHE_KEY = 'local'
const WINDOWS_HOST_DEFAULT_CACHE_KEY = 'windows-host-default'

function preflightCacheKey(
  wslTarget: WslPreflightTarget | null,
  windowsHostDefault: boolean
): string {
  if (wslTarget) {
    return `wsl:${wslTarget.distro ?? ''}`
  }
  return windowsHostDefault ? WINDOWS_HOST_DEFAULT_CACHE_KEY : LOCAL_PREFLIGHT_CACHE_KEY
}

/** @internal - tests need a clean preflight cache between cases. */
export function _resetPreflightCache(): void {
  cached = null
  cachedByRuntime.clear()
  preflightInFlight.clear()
  latestPreflightRun.clear()
  // In-flight probes must not repopulate the cleared cache.
  preflightCacheEpoch += 1
}

export type RefreshAgentsResult = {
  agents: string[]
  addedPathSegments: string[]
  /** False means detection used existing PATH after shell failure. */
  shellHydrationOk: boolean
  /** Distinguish shell-hydrated PATH from the packaged seed for missing-agent triage. */
  pathSource: PathSource
  pathFailureReason: ShellHydrationFailureReason
}

/** Refresh login-shell PATH so newly installed CLIs appear without restarting Orca. */
export async function refreshShellPathAndDetectAgents(
  context?: PreflightRuntimeContext,
  options?: InstalledAgentDetectionOptions
): Promise<RefreshAgentsResult> {
  const wslTarget = getPreflightWslTarget(context)
  if (wslTarget) {
    // Discard cached guest PATH before detecting a newly installed WSL CLI.
    invalidateWslGuestEnvironment(wslTarget.distro)
    const agents = await detectInstalledAgents(context, options)
    return {
      agents,
      addedPathSegments: [],
      shellHydrationOk: true,
      pathSource: 'sync_seed_only',
      pathFailureReason: 'none'
    }
  }

  const hydration = await hydrateShellPath({ force: true })
  const added = hydration.ok ? mergePathSegments(hydration.segments) : []
  const agents = await detectInstalledAgents(context, options)
  return {
    agents,
    addedPathSegments: added,
    shellHydrationOk: hydration.ok,
    pathSource: hydration.ok ? 'shell_hydrate' : 'sync_seed_only',
    pathFailureReason: hydration.failureReason
  }
}

// Local auth must use the verified binary, bypassing dead PATH shims; WSL resolves inside its guest (#22975).
async function isGhAuthenticated(probe: CommandRuntime): Promise<boolean> {
  try {
    await (probe.wslTarget
      ? execCommandInWslOrThrow(probe.wslTarget, `${quotePosixShell('gh')} auth status`)
      : execLocalPreflightCommandOrThrow(probe.binary ?? 'gh', ['auth', 'status']))
    return true
  } catch (error) {
    // Some nonzero auth results retain success markers; preserve compatibility with partial output.
    const stdout = (error as { stdout?: string }).stdout ?? ''
    const stderr = (error as { stderr?: string }).stderr ?? ''
    const output = `${stdout}\n${stderr}`
    return output.includes('Logged in') || output.includes('Active account: true')
  }
}

// glab versions split auth status across stdout/stderr; inspect both.
async function isGlabAuthenticated(probe: CommandRuntime): Promise<boolean> {
  try {
    await (probe.wslTarget
      ? execCommandInWslOrThrow(probe.wslTarget, `${quotePosixShell('glab')} auth status`)
      : execLocalPreflightCommandOrThrow(probe.binary ?? 'glab', ['auth', 'status'], {
          // `auth status` calls the GitLab API, so it needs the Settings proxy too.
          env: withConfiguredProxyEnv(buildLocalPreflightEnv())
        }))
    return true
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout ?? ''
    const stderr = (error as { stderr?: string }).stderr ?? ''
    const output = `${stdout}\n${stderr}`
    return output.includes('Logged in')
  }
}

export async function runPreflightCheck(
  force = false,
  context?: PreflightRuntimeContext
): Promise<PreflightStatus> {
  const wslTarget = getPreflightWslTarget(context)
  const windowsHostDefault = !wslTarget && isWindowsHostDefault(context)
  const cacheKey = preflightCacheKey(wslTarget, windowsHostDefault)
  prunePreflightWslCache(
    cachedByRuntime,
    latestPreflightRun,
    Date.now(),
    MAX_WSL_PREFLIGHT_DISTRO_ENTRIES
  )

  if (!force) {
    if (cacheKey !== LOCAL_PREFLIGHT_CACHE_KEY) {
      const entry = cachedByRuntime.get(cacheKey)
      if (entry && entry.expiresAt > Date.now()) {
        return entry.result
      }
    } else if (cached) {
      return cached
    }
    const inFlight = preflightInFlight.get(cacheKey)
    if (inFlight) {
      return (await inFlight).status
    }
  }

  const runId = ++preflightRunCounter
  const epochAtStart = preflightCacheEpoch
  latestPreflightRun.set(cacheKey, runId)

  const run = executePreflightCheck(force, context, wslTarget, windowsHostDefault)
  preflightInFlight.set(cacheKey, run)
  try {
    const { status: result, refusedWslDistro } = await run
    // Superseded/reset probes may answer their caller but cannot populate the cache.
    const isCurrent =
      latestPreflightRun.get(cacheKey) === runId && epochAtStart === preflightCacheEpoch
    if (isCurrent) {
      if (cacheKey !== LOCAL_PREFLIGHT_CACHE_KEY) {
        cachedByRuntime.set(cacheKey, {
          result,
          // The host default lasts the session like `cached`; a refused distro drops it once it runs.
          expiresAt: wslTarget ? Date.now() + WSL_PREFLIGHT_CACHE_TTL_MS : Number.POSITIVE_INFINITY
        })
        if (refusedWslDistro) {
          deferUntilWslDistroRunning(refusedWslDistro, 'preflight-host-default-glab', () => {
            if (cachedByRuntime.get(cacheKey)?.result === result) {
              cachedByRuntime.delete(cacheKey)
            }
          })
        }
        prunePreflightWslCache(
          cachedByRuntime,
          latestPreflightRun,
          Date.now(),
          MAX_WSL_PREFLIGHT_DISTRO_ENTRIES
        )
      } else {
        cached = result
      }
    }
    return result
  } finally {
    // A newer forced probe must remain joinable after this older probe settles.
    if (preflightInFlight.get(cacheKey) === run) {
      preflightInFlight.delete(cacheKey)
    }
  }
}

async function executePreflightCheck(
  force: boolean,
  context: PreflightRuntimeContext | undefined,
  wslTarget: WslPreflightTarget | null,
  windowsHostDefault: boolean
): Promise<PreflightExecution> {
  if (wslTarget) {
    // Mounts and polls must not start a stopped distro (E9); window focus and retry clicks wake it.
    await assertWslDistroRunningForExec(wslTarget.distro)
  }
  if (process.platform === 'win32' && !wslTarget) {
    await mergePersistedWindowsPathAsync(process.env, { forceRefresh: force })
  } else if (process.platform !== 'win32') {
    await hydrateShellPathForAgentDetection(context, force)
  }

  if (force) {
    // Refresh GitLab host discovery too, or self-hosted login stays invisible until relaunch.
    _resetKnownHostsCache()
  }

  const [gitProbe, ghProbe, nativeGlabProbe] = await Promise.all([
    detectCommandRuntime('git', context),
    detectCommandRuntime('gh', context),
    detectCommandRuntime('glab', context)
  ])
  // Availability must match where a cwd-less glab call really runs, or the GitLab tab disappears.
  const glabProbe =
    windowsHostDefault && nativeGlabProbe.absent ? await detectDefaultWslGlab() : nativeGlabProbe

  const [ghAuthenticated, glabAuthenticated, bitbucket, azureDevOps, gitea] = await Promise.all([
    ghProbe.installed ? isGhAuthenticated(ghProbe) : Promise.resolve(false),
    glabProbe.installed ? isGlabAuthenticated(glabProbe) : Promise.resolve(false),
    getBitbucketAuthStatus(),
    getAzureDevOpsAuthStatus(),
    getGiteaAuthStatus()
  ])

  return {
    status: {
      git: { installed: gitProbe.installed },
      gh: { installed: ghProbe.installed, authenticated: ghAuthenticated },
      glab: { installed: glabProbe.installed, authenticated: glabAuthenticated },
      bitbucket,
      azureDevOps,
      gitea
    },
    ...(glabProbe.refusedWslDistro ? { refusedWslDistro: glabProbe.refusedWslDistro } : {})
  }
}
