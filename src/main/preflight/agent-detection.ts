/**
 * Agent/tool preflight detection. Split out of `ipc/preflight.ts` so the Orca
 * runtime — which calls `detectInstalledAgentsWithShellPathHydration` and
 * `detectRemoteAgents` during normal operation — can reach this logic without
 * dragging `ipcMain` into its module graph. The Electron handler registration
 * stays in `ipc/preflight.ts` and imports from here.
 */
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
import { getActiveMultiplexer } from '../ssh/ssh-target-registry'
import {
  detectWslCommandsOnPath,
  type WslPreflightTarget
} from '../ipc/preflight-wsl-agent-detection'
import { detectCommandsInInstallDirs } from '../ipc/local-agent-install-dir-detection'
import {
  getPreflightWslTarget,
  type PreflightRuntimeContext
} from '../ipc/preflight-runtime-target'

export type { PreflightRuntimeContext }
import { hydrateShellPathForAgentDetection } from '../ipc/agent-detection-shell-path'
import {
  execCommandInWslOrThrow,
  execLocalPreflightCommandOrThrow,
  isCommandAvailable,
  isCommandOnPath,
  shellQuote
} from '../ipc/preflight-command-exec'
import {
  detectRemoteWindowsTerminalCapabilities,
  type RemoteWindowsTerminalCapabilities
} from '../ipc/preflight-remote-windows-terminal-capabilities'
import {
  getTuiAgentDetectionProbeCommands,
  KNOWN_TUI_AGENT_DETECTION_COMMANDS,
  resolveDetectedTuiAgentIds
} from '../ipc/tui-agent-detection-commands'
import { invalidateWslGuestEnvironment } from '../wsl/wsl-guest-environment'

export type PreflightStatus = {
  git: { installed: boolean }
  gh: { installed: boolean; authenticated: boolean }
  // Why: optional so existing renderer call sites that only render git/gh
  // status keep typechecking. Consumers that surface GitLab-specific
  // affordances (the GitLab tab in the source picker, MR list, etc.)
  // gate on `glab?.authenticated`.
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

// Why: cache the result so repeated Landing mounts don't re-spawn processes.
// The check only runs once per app session — relaunch to re-check.
let cached: PreflightStatus | null = null
// Why keyed by distro rather than one slot: each distro carries its own
// toolchain, so distro A's result must never answer for distro B. Previously a
// WSL target skipped the cache entirely and re-spawned five wsl.exe probes —
// two of them login shells — on every caller, waking an idle VM each time.
//
// Why a TTL here when the local cache lasts the session: `isCommandAvailable`
// collapses every failure into `installed: false`, so an unreachable distro is
// indistinguishable from one with no tooling. Pinning that for the session
// would report "git not installed" until relaunch; expiring lets it self-heal
// while still collapsing the burst of calls that made this expensive.
const WSL_PREFLIGHT_CACHE_TTL_MS = 30_000
const cachedByWslDistro = new Map<string, { result: PreflightStatus; expiresAt: number }>()
// Collapses concurrent callers (several panes mounting at once) onto one probe
// set instead of one full set each before the first result lands.
const preflightInFlight = new Map<string, Promise<PreflightStatus>>()

// Why a generation per key: two runs for the same target can overlap (a forced
// refresh started while a slower probe is still out). Without this the slower
// one settles last and writes its older result over the newer one, so the next
// caller reads staler status than the refresh it asked for. The epoch does the
// same for `_resetPreflightCache`, which integrations call on credential
// changes: a probe already in flight must not repopulate the cache it cleared.
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
  // Why bump rather than just clear: a probe already in flight would otherwise
  // settle after this and repopulate the cache an integration just invalidated.
  preflightCacheEpoch += 1
}

function uniqueAgentIds(ids: Iterable<string>): string[] {
  return [...new Set(ids)]
}

async function detectCommandRuntime(
  command: string,
  context?: PreflightRuntimeContext
): Promise<{ installed: boolean; wslTarget?: WslPreflightTarget }> {
  const wslTarget = getPreflightWslTarget(context)
  if (wslTarget) {
    return (await isCommandAvailable(command, wslTarget))
      ? { installed: true, wslTarget }
      : { installed: false }
  }
  if (await isCommandAvailable(command)) {
    return { installed: true }
  }
  return { installed: false }
}

export async function detectInstalledAgents(context?: PreflightRuntimeContext): Promise<string[]> {
  const wslTarget = getPreflightWslTarget(context)
  if (wslTarget) {
    const foundCommands = await detectWslCommandsOnPath(
      wslTarget,
      getTuiAgentDetectionProbeCommands(KNOWN_TUI_AGENT_DETECTION_COMMANDS, 'wsl')
    )
    return resolveDetectedTuiAgentIds(KNOWN_TUI_AGENT_DETECTION_COMMANDS, foundCommands, 'wsl')
  }

  const probeCommands = getTuiAgentDetectionProbeCommands(
    KNOWN_TUI_AGENT_DETECTION_COMMANDS,
    process.platform
  )
  const pathChecks = await Promise.all(
    probeCommands.map(async (cmd) => ({
      cmd,
      installedOnPath: await isCommandOnPath(cmd)
    }))
  )
  const missedCommands = pathChecks.filter((check) => !check.installedOnPath).map(({ cmd }) => cmd)
  // Why: PATH may still be unhydrated on a cold GUI launch; bulk resolution
  // computes user install dirs once instead of blocking once per missed CLI.
  const installDirCommands = detectCommandsInInstallDirs(missedCommands)
  const foundCommands = new Set(
    pathChecks
      .filter(({ cmd, installedOnPath }) => installedOnPath || installDirCommands.has(cmd))
      .map(({ cmd }) => cmd)
  )
  return resolveDetectedTuiAgentIds(
    KNOWN_TUI_AGENT_DETECTION_COMMANDS,
    foundCommands,
    process.platform
  )
}

export async function detectInstalledAgentsWithShellPathHydration(
  context?: PreflightRuntimeContext
): Promise<string[]> {
  await hydrateShellPathForAgentDetection(context)
  return detectInstalledAgents(context)
}

export type RefreshAgentsResult = {
  /** Agents detected after hydrating PATH from the user's login shell. */
  agents: string[]
  /** PATH segments that were added this refresh (empty if nothing new). */
  addedPathSegments: string[]
  /** True when the shell spawn succeeded. False = relied on existing PATH. */
  shellHydrationOk: boolean
  /** Whether `detectInstalledAgents` ran against shell-hydrated PATH or only
   *  the seed list from `patchPackagedProcessPath`. Drives the on_path:false
   *  triage in tile A on dashboard 1562016. */
  pathSource: PathSource
  /** Why hydration failed (or `'none'` on success). Typed against the shared
   *  alias so the IPC boundary stays in lockstep with the renderer-visible
   *  enum on `onboardingAgentPickedSchema`. */
  pathFailureReason: ShellHydrationFailureReason
}

/**
 * Re-spawn the user's login shell to refresh process.env.PATH, then re-run
 * agent detection. Called by the Agents settings pane when the user clicks
 * Refresh — handles the "installed a new CLI, Orca doesn't see it yet" case
 * without requiring an app restart.
 */
export async function refreshShellPathAndDetectAgents(
  context?: PreflightRuntimeContext
): Promise<RefreshAgentsResult> {
  const wslTarget = getPreflightWslTarget(context)
  if (wslTarget) {
    // Why invalidate first: the guest PATH is cached per distro for the process
    // lifetime, so Refresh would otherwise re-read the pre-install PATH and
    // keep reporting a just-installed CLI as absent -- the exact case this
    // function exists to handle.
    invalidateWslGuestEnvironment(wslTarget.distro)
    const agents = await detectInstalledAgents(context)
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
  const agents = await detectInstalledAgents(context)
  return {
    agents,
    addedPathSegments: added,
    shellHydrationOk: hydration.ok,
    pathSource: hydration.ok ? 'shell_hydrate' : 'sync_seed_only',
    pathFailureReason: hydration.failureReason
  }
}

export async function detectRemoteAgents(args: { connectionId: string }): Promise<string[]> {
  const mux = getActiveMultiplexer(args.connectionId)
  if (!mux || mux.isDisposed()) {
    // Why: remote agent detection is passive UI polling. A disconnected host has
    // no detectable agents until reconnect, but should not spam IPC errors.
    return []
  }
  const result = (await mux.request('preflight.detectAgents', {
    commands: KNOWN_TUI_AGENT_DETECTION_COMMANDS
  })) as { agents: string[] }
  return uniqueAgentIds(result.agents)
}

async function isGhAuthenticated(wslTarget?: WslPreflightTarget): Promise<boolean> {
  try {
    await (wslTarget
      ? execCommandInWslOrThrow(wslTarget, `${shellQuote('gh')} auth status`)
      : execLocalPreflightCommandOrThrow('gh', ['auth', 'status']))
    // Why: for plain-text `gh auth status`, exit 0 means gh did not detect any
    // authentication issues for the checked hosts/accounts.
    return true
  } catch (error) {
    // Why: some environments may surface partial command output on the thrown
    // error object. Keep a compatibility fallback so we avoid a false auth
    // warning if success markers are present despite a non-zero result.
    const stdout = (error as { stdout?: string }).stdout ?? ''
    const stderr = (error as { stderr?: string }).stderr ?? ''
    const output = `${stdout}\n${stderr}`
    return output.includes('Logged in') || output.includes('Active account: true')
  }
}

// Why: parallel to isGhAuthenticated for the glab CLI. glab writes auth
// status to stderr in some versions and stdout in others; check both.
async function isGlabAuthenticated(wslTarget?: WslPreflightTarget): Promise<boolean> {
  try {
    await (wslTarget
      ? execCommandInWslOrThrow(wslTarget, `${shellQuote('glab')} auth status`)
      : execLocalPreflightCommandOrThrow('glab', ['auth', 'status']))
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
    // Superseded by a newer run, or the cache was reset while this was out:
    // return what we probed, but do not let it become the cached answer.
    const isCurrent =
      latestPreflightRun.get(cacheKey) === runId && epochAtStart === preflightCacheEpoch
    if (isCurrent) {
      if (wslTarget) {
        cachedByWslDistro.set(cacheKey, {
          result,
          expiresAt: Date.now() + WSL_PREFLIGHT_CACHE_TTL_MS
        })
      } else {
        cached = result
      }
    }
    return result
  } finally {
    // Why the identity check: a concurrent force run replaces this entry, and
    // that newer run must stay joinable after this one settles.
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
  }

  if (force) {
    // Why: the GitLab known-hosts cache (gl-utils) is populated lazily on the
    // first GitLab request and never invalidated within a session. A user who
    // runs `glab auth login` for a self-hosted host after Orca starts would
    // otherwise see "No GitLab project found" until app relaunch. The Re-check
    // path in IntegrationsPane forces preflight, so piggyback on that signal
    // to refresh the host list too.
    _resetKnownHostsCache()
  }

  const [gitProbe, ghProbe, glabProbe] = await Promise.all([
    detectCommandRuntime('git', context),
    detectCommandRuntime('gh', context),
    detectCommandRuntime('glab', context)
  ])

  const [ghAuthenticated, glabAuthenticated, bitbucket, azureDevOps, gitea] = await Promise.all([
    ghProbe.installed ? isGhAuthenticated(ghProbe.wslTarget) : Promise.resolve(false),
    glabProbe.installed ? isGlabAuthenticated(glabProbe.wslTarget) : Promise.resolve(false),
    getBitbucketAuthStatus(),
    getAzureDevOpsAuthStatus(),
    getGiteaAuthStatus()
  ])

  const result = {
    git: { installed: gitProbe.installed },
    gh: { installed: ghProbe.installed, authenticated: ghAuthenticated },
    glab: { installed: glabProbe.installed, authenticated: glabAuthenticated },
    bitbucket,
    azureDevOps,
    gitea
  }

  return result
}
