// Runtime preflight must stay independent of ipcMain registration.
import type {
  PathSource,
  ShellHydrationFailureReason
} from '../../shared/shell-path-hydration-types'
import { hydrateShellPath, mergePathSegments } from '../startup/hydrate-shell-path'
import { getAzureDevOpsAuthStatus } from '../azure-devops/client'
import { getBitbucketAuthStatus } from '../bitbucket/client'
import { getGiteaAuthStatus } from '../gitea/client'
import { _resetKnownHostsCache } from '../gitlab/gl-utils'
import { mergePersistedWindowsPathAsync } from '../pty/windows-environment-path'
import type { WslPreflightTarget } from '../ipc/preflight-wsl-agent-detection'
import {
  getPreflightWslTarget,
  type PreflightRuntimeContext
} from '../ipc/preflight-runtime-target'

export type { PreflightRuntimeContext }
import { hydrateShellPathForAgentDetection } from '../ipc/agent-detection-shell-path'
import {
  execCommandInWslOrThrow,
  execLocalPreflightCommandOrThrow,
  findRunnableLocalCommand,
  isCommandAvailable
} from '../ipc/preflight-command-exec'
import { quotePosixShell } from '../../shared/shell-argument-quoting'
import {
  detectRemoteWindowsTerminalCapabilities,
  type RemoteWindowsTerminalCapabilities
} from '../ipc/preflight-remote-windows-terminal-capabilities'
import { invalidateWslGuestEnvironment } from '../wsl/wsl-guest-environment'
import { prunePreflightWslCache } from '../preflight-wsl-cache'
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
const cachedByWslDistro = new Map<string, { result: PreflightStatus; expiresAt: number }>()
const preflightInFlight = new Map<string, Promise<PreflightStatus>>()

// Per-key generations and reset epochs prevent older probes repopulating refreshed/cleared caches.
const latestPreflightRun = new Map<string, number>()
let preflightRunCounter = 0
let preflightCacheEpoch = 0

const LOCAL_PREFLIGHT_CACHE_KEY = 'local'

function preflightCacheKey(wslTarget: WslPreflightTarget | null): string {
  return wslTarget ? `wsl:${wslTarget.distro ?? ''}` : LOCAL_PREFLIGHT_CACHE_KEY
}

/** @internal - tests need a clean preflight cache between cases. */
export function _resetPreflightCache(): void {
  cached = null
  cachedByWslDistro.clear()
  preflightInFlight.clear()
  latestPreflightRun.clear()
  // In-flight probes must not repopulate the cleared cache.
  preflightCacheEpoch += 1
}

/** A CLI verdict and, on the local path, the exact copy that produced it. */
type CommandRuntime = { installed: boolean; wslTarget?: WslPreflightTarget; binary?: string }

async function detectCommandRuntime(
  command: string,
  context?: PreflightRuntimeContext
): Promise<CommandRuntime> {
  const wslTarget = getPreflightWslTarget(context)
  if (wslTarget) {
    return (await isCommandAvailable(command, wslTarget))
      ? { installed: true, wslTarget }
      : { installed: false }
  }
  // Pin auth to the copy that passed --version, so PATH cannot select the dead shim again.
  const probe = await findRunnableLocalCommand(command)
  return probe.status === 'available'
    ? { installed: true, binary: probe.binary }
    : { installed: false }
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
      : execLocalPreflightCommandOrThrow(probe.binary ?? 'glab', ['auth', 'status']))
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
  const cacheKey = preflightCacheKey(wslTarget)
  prunePreflightWslCache(
    cachedByWslDistro,
    latestPreflightRun,
    Date.now(),
    MAX_WSL_PREFLIGHT_DISTRO_ENTRIES
  )

  if (!force) {
    if (wslTarget) {
      const entry = cachedByWslDistro.get(cacheKey)
      if (entry && entry.expiresAt > Date.now()) {
        return entry.result
      }
    } else if (cached) {
      return cached
    }
    const inFlight = preflightInFlight.get(cacheKey)
    if (inFlight) {
      return inFlight
    }
  }

  const runId = ++preflightRunCounter
  const epochAtStart = preflightCacheEpoch
  latestPreflightRun.set(cacheKey, runId)

  const run = executePreflightCheck(force, context, wslTarget)
  preflightInFlight.set(cacheKey, run)
  try {
    const result = await run
    // Superseded/reset probes may answer their caller but cannot populate the cache.
    const isCurrent =
      latestPreflightRun.get(cacheKey) === runId && epochAtStart === preflightCacheEpoch
    if (isCurrent) {
      if (wslTarget) {
        cachedByWslDistro.set(cacheKey, {
          result,
          expiresAt: Date.now() + WSL_PREFLIGHT_CACHE_TTL_MS
        })
        prunePreflightWslCache(
          cachedByWslDistro,
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
  wslTarget: WslPreflightTarget | null
): Promise<PreflightStatus> {
  if (process.platform === 'win32' && !wslTarget) {
    await mergePersistedWindowsPathAsync(process.env, { forceRefresh: force })
  } else if (process.platform !== 'win32') {
    await hydrateShellPathForAgentDetection(context, force)
  }

  if (force) {
    // Refresh GitLab host discovery too, or self-hosted login stays invisible until relaunch.
    _resetKnownHostsCache()
  }

  const [gitProbe, ghProbe, glabProbe] = await Promise.all([
    detectCommandRuntime('git', context),
    detectCommandRuntime('gh', context),
    detectCommandRuntime('glab', context)
  ])

  const [ghAuthenticated, glabAuthenticated, bitbucket, azureDevOps, gitea] = await Promise.all([
    ghProbe.installed ? isGhAuthenticated(ghProbe) : Promise.resolve(false),
    glabProbe.installed ? isGlabAuthenticated(glabProbe) : Promise.resolve(false),
    getBitbucketAuthStatus(),
    getAzureDevOpsAuthStatus(),
    getGiteaAuthStatus()
  ])

  return {
    git: { installed: gitProbe.installed },
    gh: { installed: ghProbe.installed, authenticated: ghAuthenticated },
    glab: { installed: glabProbe.installed, authenticated: glabAuthenticated },
    bitbucket,
    azureDevOps,
    gitea
  }
}
