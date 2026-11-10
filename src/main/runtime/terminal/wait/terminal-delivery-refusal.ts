import type { MailboxDeliveryHold } from '../../orchestration/mailbox/delivery-hold/mailbox-delivery-hold'
import { isTuiIdleReadyVerdict, type TuiIdleVerdict } from './tui-idle-evidence'

/** Why pointer plus Enter would not be typed into a settled-looking worker terminal now (dialogs and
 *  drafts are checked first); null means it would. Takes the waits' readiness ranking plus a working
 *  verdict: agents queue or steer text sent mid-turn. */
export function terminalDeliveryRefusal(input: {
  verdict: TuiIdleVerdict
  recognizedAgent: boolean
  readScreenInputVeto: () => boolean | null | undefined
}): MailboxDeliveryHold | null {
  const { verdict } = input
  // The ranking vetoes overlays only on ready verdicts; an overlay refuses input mid-turn too.
  // Only a recognized agent queues mid-turn text; an unknown program would read it as stdin.
  if (verdict.kind === 'working') {
    return !input.recognizedAgent
      ? { kind: 'busy-program' }
      : input.readScreenInputVeto() === true
        ? { kind: 'overlay' }
        : null
  }
  if (isTuiIdleReadyVerdict(verdict)) {
    return null
  }
  return verdict.kind === 'blocked'
    ? { kind: 'blocked', reason: verdict.reason }
    : { kind: 'unsettled' }
}
