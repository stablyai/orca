import type { DispatchContextRow } from '../types'

/** Correction — failed work never advances.
 *
 *  Planning the next phase is a REWARD for a completion that actually
 *  succeeded. Three independent conditions must all hold, and every typed
 *  non-success state settles or escalates instead:
 *
 *    1. the completion was ACCEPTED (the Dispatch settled `completed`),
 *    2. the reported outcome is `succeeded`,
 *    3. the completion gate, when the completion carried one, is PASS.
 *
 *  FAILED, REJECTED, BLOCKED, MISSING_RECEIPT and INVALID_CAPABILITY all fail
 *  at least one of these, so none of them can create or launch a reviewer.
 */

export type AdvanceIneligibility = {
  code:
    | 'completion_not_accepted'
    | 'outcome_failed'
    | 'completion_gate_failed'
    | 'completion_receipt_missing'
  reason: string
}

export type AdvanceEligibility = { eligible: true } | ({ eligible: false } & AdvanceIneligibility)

export function resolveAdvanceEligibility(args: {
  dispatch: Pick<DispatchContextRow, 'id' | 'status'>
  outcomeOfReport: 'succeeded' | 'failed'
  /** The gate result the completion carried, or null when it carried none. */
  gateResult: 'PASS' | 'FAIL' | null
  /** True when this Run's contract requires every completion to carry a receipt. */
  receiptRequired: boolean
}): AdvanceEligibility {
  if (args.dispatch.status !== 'completed') {
    return {
      eligible: false,
      code: 'completion_not_accepted',
      reason: `Dispatch ${args.dispatch.id} is ${args.dispatch.status}, not an accepted completion.`
    }
  }
  if (args.outcomeOfReport !== 'succeeded') {
    return {
      eligible: false,
      code: 'outcome_failed',
      reason: `Dispatch ${args.dispatch.id} reported outcome ${args.outcomeOfReport}; failed work does not earn a next phase.`
    }
  }
  if (args.gateResult === 'FAIL') {
    return {
      eligible: false,
      code: 'completion_gate_failed',
      reason: `Dispatch ${args.dispatch.id} completed with a FAIL completion gate.`
    }
  }
  if (args.receiptRequired && args.gateResult === null) {
    return {
      eligible: false,
      code: 'completion_receipt_missing',
      reason: `Dispatch ${args.dispatch.id} carried no completion receipt on a Run that requires one.`
    }
  }
  return { eligible: true }
}
