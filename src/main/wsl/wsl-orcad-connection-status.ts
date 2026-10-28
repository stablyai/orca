import type { OrcadTerminalCensus } from '../../shared/orcad-terminal-census'
import type { WslHostConnectIntent, WslHostDeferredUpdate } from '../../shared/wsl-host-types'
import type { WslLivenessUnverifiableReason } from './wsl-orcad-liveness-verdict'

/** C7 publishes terminal verdicts proven by the distro; null leaves ownership to orcad, whose reconnect census reports surviving daemon sessions. */
export type WslOrcadConnectionStatus =
  | { state: 'connecting' }
  | { state: 'ready'; census: OrcadTerminalCensus | null }
  | {
      state: 'reconnecting'
      reason: 'orcad-exited' | 'distro-restarted' | 'distro-stopped' | 'census'
      attempt: number
      /** Until the next try; null while one runs. */
      retryInMs: number | null
      terminals: 'exited' | 'unverifiable'
    }
  | {
      state: 'distro-stopped'
      terminals: 'exited'
      /** False: nothing user-visible needs it, so it is not booted; it reconnects once running. */
      recovering: boolean
    }
  | {
      state: 'unverifiable'
      reason: WslLivenessUnverifiableReason
      terminals: 'unverifiable'
    }
  /** orcad stopped (crash or managed idle exit) with nothing user-visible on it; not relaunched. */
  | { state: 'idle'; terminals: 'unverifiable' }
  | {
      state: 'failed'
      reason: string
      terminals: 'exited' | 'unverifiable'
      /** A connect the host deferred: what Update or Force would retry, since nothing serves. */
      deferredUpdate?: WslHostDeferredUpdate
    }
  | { state: 'closed' }

/** What a user-initiated connect asks of the host's update. */
export type WslOrcadConnectIntent = {
  intent?: WslHostConnectIntent
  /** E9: only reconnect a distro confirmed running; a runtime call must never boot one. */
  noBoot?: boolean
  /** How a no-boot connect confirms the distro runs (set by the connector). */
  requireRunning?: (distro: string) => Promise<boolean>
}

/** Retain failed-connect deferrals so Update/Force remains available when nothing serves. */
export function wslConnectFailedStatus(
  reason: string,
  deferral: WslHostDeferredUpdate | null
): WslOrcadConnectionStatus {
  if (!deferral) {
    return { state: 'failed', reason, terminals: 'unverifiable' }
  }
  const { candidateVersion, code, reason: why, forceable } = deferral
  const deferredUpdate = { candidateVersion, code, reason: why, forceable }
  return { state: 'failed', reason, terminals: 'unverifiable', deferredUpdate }
}
