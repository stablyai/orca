// DI seam for WslHookRelayManager: the full dependency contract plus the
// production wiring. Tests construct the manager with fakes for everything
// that spawns wsl.exe or touches the live agentHookServer.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { agentHookServer } from './server'
import { installRemoteManagedAgentHooks } from './remote-managed-hook-installers'
import {
  isWslDistroRunning,
  resolveWslHookRelayBundle,
  runWslInstallProcess,
  spawnWslRelayProcess
} from './wsl-hook-relay-launch'
import { waitForWslRelaySentinel } from './wsl-hook-relay-sentinel'
import { listWslDistrosAsync } from '../wsl'
import { isRemoteAgentHooksEnabled } from '../../shared/agent-hook-relay'

// Why: fresh WSL intermittently throws "Catastrophic failure (E_UNEXPECTED)"
// under concurrent wsl.exe spawn load; the retry pause is a dep so tests can
// collapse it.
export const WSL_RELAY_TRANSIENT_RETRY_DELAY_MS = 2_000

// Restart/cooldown policy for the manager's state machine.
export const FAILURE_COOLDOWN_BASE_MS = 60_000
export const FAILURE_COOLDOWN_MAX_MS = 10 * 60_000
// Why: a distro without node >= 18 will not grow one mid-session; probe
// rarely instead of once per PTY spawn.
export const NO_NODE_COOLDOWN_MS = 10 * 60_000
// Why: a previously-healthy relay dying mid-session (mux protocol error, WSL
// restart) must self-recover — a live agent session produces no new PTY
// spawns, so waiting for the next ensure would leave status dead for good.
export const RUNNING_TEARDOWN_COOLDOWN_MS = 10_000
// Why: only a relay that stayed up this long resets the failure counter — a
// connect-then-crash loop must keep escalating its cooldown, not sit at the
// running-teardown base forever.
export const STABLE_UPTIME_MS = 2 * 60_000
// Why: re-running the (byte-equality idempotent) installers picks up configs
// that appear after first install — e.g. Codex's runtime-home config.toml is
// seeded by the launch path, so its hook-trust entries can only be written
// once that file exists. The one-shot timer covers single-spawn sessions.
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
  isDistroRunning: typeof isWslDistroRunning
  spawnRelay: typeof spawnWslRelayProcess
  runInstall: typeof runWslInstallProcess
  waitForSentinel: typeof waitForWslRelaySentinel
  ingest: (envelope: Record<string, unknown>, connectionId: string) => void
  installHooks: typeof installRemoteManagedAgentHooks
  warn: (message: string) => void
  transientRetryDelayMs: number
}

export const defaultWslHookRelayDeps: WslHookRelayManagerDeps = {
  platform: () => process.platform,
  remoteHooksEnabled: () => isRemoteAgentHooksEnabled(),
  hookCoordsEnv: () => agentHookServer.buildPtyEnv(),
  // Why: the Windows endpoint file path (userData + namespace) is stable
  // across app restarts and distinct per instance — exactly the identity the
  // guest endpoint dir must carry so surviving agents re-coordinate.
  instanceKey: () => {
    const source = agentHookServer.endpointFilePath
    return source ? createHash('sha256').update(source).digest('hex').slice(0, 12) : null
  },
  resolveBundle: resolveWslHookRelayBundle,
  readBundle: (jsPath) => readFileSync(jsPath),
  listDistros: () => listWslDistrosAsync(),
  isDistroRunning: isWslDistroRunning,
  spawnRelay: spawnWslRelayProcess,
  runInstall: runWslInstallProcess,
  waitForSentinel: waitForWslRelaySentinel,
  ingest: (envelope, connectionId) =>
    agentHookServer.ingestRemote(
      envelope as Parameters<typeof agentHookServer.ingestRemote>[0],
      connectionId
    ),
  installHooks: installRemoteManagedAgentHooks,
  warn: (message) => console.warn(message),
  transientRetryDelayMs: WSL_RELAY_TRANSIENT_RETRY_DELAY_MS
}
