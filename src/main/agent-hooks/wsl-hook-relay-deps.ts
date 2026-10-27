import { CLAUDE_AGENT_VIEW_MOD_SOURCE } from '../claude/agent-view-mod-source'
import { bindRemoteClaudeInterruptReconciliation } from '../ssh/ssh-agent-hook-interrupt-reconciliation'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { isAgentStatusHooksEnabled } from './managed-agent-hook-controls'
import { AGENT_STATUS_LEGACY_UNADVERTISED_PEER_CAPABILITIES } from '../../shared/agent-status-legacy-adapter'
import { agentHookServer } from './server'
import type { ManagedHookDetectionSettings } from './managed-hook-detection-commands'
import { installRemoteManagedAgentHooks } from './remote-managed-hook-installers'
import { getOpenCode2PluginSource, getOpenCodePluginSource } from '../opencode/hook-service'
import { getPiAgentStatusExtensionSource } from '../pi/agent-status-extension-source'
import { codexHookService } from '../codex/hook-service'
import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'
import type { PluginSources } from '../../wsl-guest/plugin-overlay'
import {
  resolveWslHookRelayBundle,
  runWslInstallProcess,
  spawnWslRelayProcess
} from './wsl-hook-relay-launch'
import { waitForWslRelaySentinel } from './wsl-hook-relay-sentinel'
import { listWslDistrosAsync } from '../wsl'
import { deferUntilWslDistroRunning, isWslDistroRunning } from '../wsl-background-distro-gate'
import { isWslAgentHookRelayEnabled } from '../../shared/agent-hook-relay'

// Concurrent wsl.exe spawns can trigger transient E_UNEXPECTED failures.
export const WSL_RELAY_TRANSIENT_RETRY_DELAY_MS = 2_000

export const FAILURE_COOLDOWN_BASE_MS = 60_000
export const FAILURE_COOLDOWN_MAX_MS = 10 * 60_000
// Rate-limit unsupported Node probes rather than repeating them for every PTY spawn.
export const NO_NODE_COOLDOWN_MS = 10 * 60_000
// Recover without a new PTY spawn so surviving agent sessions regain status updates.
export const RUNNING_TEARDOWN_COOLDOWN_MS = 10_000
// Only stable uptime resets failures; rapid connect/crash loops must keep escalating cooldown.
export const STABLE_UPTIME_MS = 2 * 60_000
// Retry idempotent installs after launch creates configs; the one-shot covers single-spawn sessions.
export const REINSTALL_MIN_INTERVAL_MS = 30_000
export const REINSTALL_ONE_SHOT_DELAY_MS = 60_000

export type WslHookRelayManagerDeps = {
  platform: () => NodeJS.Platform
  remoteHooksEnabled: () => boolean
  hookCoordsEnv: () => Record<string, string>
  /** Restart-stable, instance-unique key for the guest endpoint dir. */
  instanceKey: () => string | null
  resolveBundle: typeof resolveWslHookRelayBundle
  readBundle: (jsPath: string) => Buffer
  listDistros: () => Promise<string[]>
  /** Recovery must not boot a distro the user shut down. */
  isDistroRunning: typeof isWslDistroRunning
  deferUntilRunning: typeof deferUntilWslDistroRunning
  spawnRelay: typeof spawnWslRelayProcess
  runInstall: typeof runWslInstallProcess
  waitForSentinel: typeof waitForWslRelaySentinel
  ingest: (envelope: Record<string, unknown>, connectionId: string) => void
  receiveClaudeAgentView?: (body: unknown) => unknown
  bindInterruptReconciliation?: (
    mux: Parameters<typeof bindRemoteClaudeInterruptReconciliation>[1],
    connectionId: string,
    isCurrent: () => boolean
  ) => () => void
  installHooks: typeof installRemoteManagedAgentHooks
  installCodex: (runtimeHomePath: string, distro: string) => Promise<AgentHookInstallStatus | null>
  managedHookSettings: () => ManagedHookDetectionSettings
  /** Update guest plugins without redeploying the relay bundle. */
  pluginSources: () => PluginSources
  warn: (message: string) => void
  transientRetryDelayMs: number
}

/** Read the hooks setting live for spawn, reattach, and crash recovery. */
export function isWslHookRelayAllowed(deps: WslHookRelayManagerDeps): boolean {
  return (
    deps.platform() === 'win32' &&
    deps.remoteHooksEnabled() &&
    isAgentStatusHooksEnabled(deps.managedHookSettings())
  )
}

export const defaultWslHookRelayDeps: WslHookRelayManagerDeps = {
  platform: () => process.platform,
  remoteHooksEnabled: () => isWslAgentHookRelayEnabled(),
  hookCoordsEnv: () => agentHookServer.buildPtyEnv(),
  receiveClaudeAgentView: (body) => agentHookServer.claudeAgentViews.receive(body),
  // A restart-stable endpoint namespace lets surviving agents rediscover this instance.
  instanceKey: () => {
    const source = agentHookServer.endpointFilePath
    return source ? createHash('sha256').update(source).digest('hex').slice(0, 12) : null
  },
  resolveBundle: resolveWslHookRelayBundle,
  readBundle: (jsPath) => readFileSync(jsPath),
  listDistros: () => listWslDistrosAsync(),
  isDistroRunning: isWslDistroRunning,
  deferUntilRunning: deferUntilWslDistroRunning,
  spawnRelay: spawnWslRelayProcess,
  runInstall: runWslInstallProcess,
  waitForSentinel: waitForWslRelaySentinel,
  // WSL advertises no run-serving capability; annotate a copy of the received notification.
  ingest: (envelope, connectionId) => {
    const capped = {
      ...envelope,
      advertisedAgentStatusCapabilities: AGENT_STATUS_LEGACY_UNADVERTISED_PEER_CAPABILITIES
    }
    type IngestEnvelope = Parameters<typeof agentHookServer.ingestRemote>[0]
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: envelope is the wire-deserialized notification; ingestRemote independently re-validates paneKey's type before trusting anything here.
    return agentHookServer.ingestRemote(capped as IngestEnvelope, connectionId)
  },
  bindInterruptReconciliation: (mux, connectionId, isCurrent) =>
    bindRemoteClaudeInterruptReconciliation(agentHookServer, mux, connectionId, isCurrent),
  installHooks: installRemoteManagedAgentHooks,
  installCodex: (runtimeHomePath, distro) =>
    codexHookService.installForRuntimeHomeSerialized(runtimeHomePath, {
      runtime: 'wsl',
      wslDistro: distro
    }),
  managedHookSettings: () => null,
  pluginSources: () => ({
    claudeAgentViewSource: CLAUDE_AGENT_VIEW_MOD_SOURCE,
    opencodePluginSource: getOpenCodePluginSource(),
    opencode2PluginSource: getOpenCode2PluginSource(),
    piExtensionSource: getPiAgentStatusExtensionSource('pi'),
    ompExtensionSource: getPiAgentStatusExtensionSource('omp')
  }),
  warn: (message) => console.warn(message),
  transientRetryDelayMs: WSL_RELAY_TRANSIENT_RETRY_DELAY_MS
}
