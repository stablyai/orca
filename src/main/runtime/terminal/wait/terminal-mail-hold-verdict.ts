import type { MailboxDeliveryHold } from '../../orchestration/mailbox/delivery-hold/mailbox-delivery-hold'
import type { MailboxForeground } from './launched-agent-foreground'

const CORROBORATED_HOLDS: ReadonlySet<MailboxDeliveryHold['kind']> = new Set([
  'prompt',
  'draft',
  'blocked',
  'overlay'
])

/** The hold a send receipt reports, from the delivery gate's refusal and the foreground probe. */
export function terminalMailHoldVerdict(input: {
  refusal: MailboxDeliveryHold | 'no-terminal' | null
  foreground: MailboxForeground | undefined
  agentName: string
  foregroundHeld: () => boolean
  takingInput: boolean
  /** The probe saw the agent in front and its status is live: the gate's own verdict stands. */
  agentInFront: boolean
  terminalHandle: string
}): MailboxDeliveryHold | null {
  const { refusal, agentName } = input
  if (refusal === 'no-terminal') {
    return null
  }
  if (refusal && ['prompt', 'draft', 'restoring'].includes(refusal.kind)) {
    return refusal
  }
  if (input.foreground === 'shell') {
    return { kind: 'not-foreground', agentName }
  }
  if (input.foregroundHeld()) {
    return { kind: 'not-live', agentName }
  }
  if (input.takingInput || input.agentInFront) {
    return refusal
  }
  // Without live status, only holds Orca read on screen or from the agent stay true once status arrives.
  return refusal && CORROBORATED_HOLDS.has(refusal.kind)
    ? refusal
    : { kind: 'unverified', terminal: input.terminalHandle }
}
