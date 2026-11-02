/**
 * Restores terminal admission after a returning client cancels an idle stop.
 *
 * Once the daemon accepts idle retirement, or may have accepted it, it never admits a terminal
 * again, so a server that stays up must replace it. A replacement ends whatever the old daemon
 * still runs, so it happens only after the daemon itself atomically agreed to retire.
 */
import { withTimeout } from '../../shared/promise-timeout-fallback'
import type { OrcadDaemonRetirement } from './orcad-daemon-retirement'
import { ORCAD_DAEMON_RETIREMENT_TIMEOUT_MS } from './orcad-stop-deadlines'

type RetirementOutcome = Pick<OrcadDaemonRetirement, 'retirement' | 'lateRetirement'>

export type OrcadIdleStopDaemonRecoveryPorts = {
  admissionClosed: () => boolean
  /** Asks the daemon to retire again; its own census and fence make the verdict atomic. */
  retireAgain: () => Promise<RetirementOutcome>
  replaceDaemon: () => Promise<unknown>
  timeoutMs?: number
}

/** `serving` when new terminals can start; `unservable` when this server cannot run any. */
export async function recoverDaemonAfterCancelledIdleStop(
  outcome: RetirementOutcome,
  ports: OrcadIdleStopDaemonRecoveryPorts
): Promise<'serving' | 'unservable'> {
  const timeoutMs = ports.timeoutMs ?? ORCAD_DAEMON_RETIREMENT_TIMEOUT_MS
  const retired = async (candidate: RetirementOutcome): Promise<boolean> =>
    candidate.retirement === 'retired' ||
    (candidate.lateRetirement !== undefined &&
      (await withTimeout(candidate.lateRetirement, timeoutMs, false)))
  if (!(await retired(outcome))) {
    if (!ports.admissionClosed()) {
      return 'serving'
    }
    // A lost stop reply leaves the daemon's verdict unknown; only the daemon can settle it.
    const retry = await ports
      .retireAgain()
      .catch((): RetirementOutcome => ({ retirement: 'unverifiable' }))
    if (!(await retired(retry))) {
      if (ports.admissionClosed()) {
        console.error('[orcad] the terminal daemon may be retiring and did not settle it')
        return 'unservable'
      }
      return 'serving'
    }
  }
  try {
    await ports.replaceDaemon()
    console.error('[orcad] a client returned during idle stop; started a fresh terminal daemon')
    return 'serving'
  } catch (error) {
    console.error('[orcad] could not replace the retired terminal daemon:', error)
    return 'unservable'
  }
}
