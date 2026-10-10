/**
 * Settling a dispatched decommission stop: proven exit, a clean cancellation, or a fence.
 *
 * Used by the decommission and by its crash recovery, so both read the host the same way. A
 * lost answer is `unverifiable`, never exit; cancelling is how a stop that did not finish is
 * withdrawn, and only an orcad-confirmed cancellation lets the fence go.
 */
import { isUnconfirmedSshCommandTermination } from './ssh-relay-deploy-helpers'
import {
  cancelRemoteOrcadManagedStop,
  completeRemoteOrcadManagedStop
} from './orcad-managed-remote-stop'
import type { OrcadSlotOptions } from './orcad-recovery-slot'
import type {
  OrcadDaemonRetirementVerdict,
  OrcadManagedStopRequest
} from '../../shared/orcad-stop-request'
import { errorMessage } from '../../shared/error-message'

export type OrcadDecommissionStopSettlement =
  | { state: 'exited'; retirement: OrcadDaemonRetirementVerdict }
  /** orcad never acted on the request and keeps serving; the verdict says why it was withdrawn. */
  | { state: 'withdrawn'; verdict: 'live' | 'unverifiable'; reason: string }
  /** orcad began stopping, or the host could not say: the fence must stay. */
  | { state: 'unsettled'; verdict: 'live' | 'unverifiable'; reason: string }

export async function settleOrcadDecommissionStop(
  options: OrcadSlotOptions,
  request: OrcadManagedStopRequest
): Promise<OrcadDecommissionStopSettlement> {
  let verdict: 'live' | 'unverifiable'
  let reason: string
  try {
    const completion = await completeRemoteOrcadManagedStop(options, request)
    if (completion.verdict === 'exited') {
      // A completion without a recorded outcome proves exit but not retirement.
      return { state: 'exited', retirement: completion.retirement ?? 'unverifiable' }
    }
    verdict = completion.verdict
    reason = `orcad ${request.version} did not exit (${completion.verdict}).`
  } catch (error) {
    if (isUnconfirmedSshCommandTermination(error)) {
      throw error
    }
    verdict = 'unverifiable'
    reason = `The host gave no verifiable stop verdict: ${errorMessage(error)}`
  }
  try {
    const cancellation = await cancelRemoteOrcadManagedStop(options, request)
    if (cancellation.outcome === 'canceled') {
      return {
        state: 'withdrawn',
        verdict,
        reason: `${reason} The stop request was withdrawn; orcad keeps serving.`
      }
    }
    return {
      state: 'unsettled',
      verdict: 'live',
      reason: `${reason} orcad already acted on the request and is still stopping.`
    }
  } catch (error) {
    if (isUnconfirmedSshCommandTermination(error)) {
      throw error
    }
    return {
      state: 'unsettled',
      verdict: 'unverifiable',
      reason: `${reason} Withdrawing the request gave no verifiable answer: ${errorMessage(error)}`
    }
  }
}
