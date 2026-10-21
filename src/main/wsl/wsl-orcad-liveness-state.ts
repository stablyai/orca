/** The supervisor's dependencies and its per-distro state. */
import type { OrcadTerminalCensus } from '../../shared/orcad-terminal-census'
import type { SystemPowerLifecycleListener } from '../system-power-lifecycle'
import type { WslRunningDistrosRead } from '../wsl-background-distro-gate'
import type { WslGuestIdentity } from './wsl-guest-process-identity'
import type { WslOrcadConnection, WslOrcadConnectionManager } from './wsl-orcad-connection'
import type { WslOrcadConnectionStatus } from './wsl-orcad-connection-status'
import type { WslLivenessEvidence, WslLivenessTrigger } from './wsl-orcad-liveness-verdict'
import type { WslOrcadReconnectBackoff } from './wsl-orcad-reconnect-backoff'
import type { WslOrcadWatch } from './wsl-orcad-watch'

/** A ready connection with a held watch re-reads only the running list this often. */
export const WSL_ORCAD_HEARTBEAT_MS = 120_000

export type WslOrcadTimer = { cancel(): void }

export type WslOrcadLivenessDependencies = {
  manager: Pick<WslOrcadConnectionManager, 'ensure' | 'get' | 'publish' | 'close'>
  readRunning: () => Promise<WslRunningDistrosRead>
  readIdentity: (distro: string, orcadPid: number | null) => Promise<WslGuestIdentity | null>
  openWatch: (connection: WslOrcadConnection) => Promise<WslOrcadWatch>
  collectCensus: (connection: WslOrcadConnection) => Promise<OrcadTerminalCensus>
  /** A WSL project or terminal the user can see is open on this distro. */
  hasUserVisibleWork: (distro: string) => boolean
  deferUntilRunning: (distro: string, key: string, task: () => unknown) => void
  /** C3's `ensureHeld`; called only while the distro is confirmed running, so it never boots. */
  ensureHolder?: (distro: string) => Promise<unknown>
  subscribePower?: (listener: SystemPowerLifecycleListener) => () => void
  monotonicNow?: () => number
  schedule?: (delayMs: number, task: () => void) => WslOrcadTimer
  random?: () => number
  heartbeatMs?: number
}

export type Trigger = WslLivenessTrigger | 'heartbeat'

export type Supervised = {
  distro: string
  key: string
  generation: number
  expected: WslLivenessEvidence['expected']
  watch: WslOrcadWatch | null
  timer: WslOrcadTimer | null
  /** Ends a recovery's backoff wait early once the distro stops being supervised. */
  wakeWait: (() => void) | null
  backoff: WslOrcadReconnectBackoff
  verifyStreak: number
  busy: boolean
  pending: Trigger | null
  state: WslOrcadConnectionStatus['state'] | null
  lastBeatMs: number
}

export function newSupervised(
  distro: string,
  key: string,
  nowMs: number,
  backoff: WslOrcadReconnectBackoff
): Supervised {
  return {
    distro: distro.trim(),
    key,
    generation: 0,
    expected: { distroInstance: null, orcad: null },
    watch: null,
    timer: null,
    wakeWait: null,
    backoff,
    verifyStreak: 0,
    busy: false,
    pending: null,
    state: null,
    lastBeatMs: nowMs
  }
}

/** Cancels the entry's timer and wake wait and closes its watch. */
export function disarmSupervised(entry: Supervised): void {
  entry.timer?.cancel()
  entry.timer = null
  entry.wakeWait?.()
  entry.wakeWait = null
  entry.watch?.close()
  entry.watch = null
}
