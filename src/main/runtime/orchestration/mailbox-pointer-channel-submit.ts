import {
  MAILBOX_POINTER_ENTER_ATTEMPTED,
  MAILBOX_POINTER_WRITE_ATTEMPTED
} from './db/messages/mailbox-pointer-enter-state'
import type { OrchestrationDb } from './db'
import type {
  OrchestrationMailboxDeliveryFlight,
  OrchestrationMailboxPointerState
} from './mailbox-pointer-state'

/** `refused`: the prompt never reached the agent; `unverifiable`: it may have. */
export type AgentPromptOutcome = 'submitted' | 'refused' | 'unverifiable'
/** Submits a prompt as a turn of the agent's own, without typing into its terminal. */
export type AgentPromptChannel = (text: string) => Promise<AgentPromptOutcome>

/** A prompt the agent declined is offered again only after this, so a refusing hook cannot spin. */
export const REFUSED_PROMPT_RETRY_MS = 5000

/** Sends a staged pointer through the agent's own prompt channel: one submission stands for the
 *  pointer text and its Enter, so the reservation settles as an Enter does. */
export function submitPointerThroughChannel(args: {
  channel: AgentPromptChannel
  text: string
  ptyId: string
  processIncarnation: string
  mailboxHandle: string
  newestSequence: number
  flight: OrchestrationMailboxDeliveryFlight
  state: OrchestrationMailboxPointerState
  getDb: () => OrchestrationDb | null
  settle: (ptyId: string, flight: OrchestrationMailboxDeliveryFlight) => void
  redrive: (mailboxHandle: string, force?: boolean) => void
}): void {
  const { ptyId, flight, mailboxHandle, newestSequence, state } = args
  const ids = flight.stagedMessageIds
  const target = { ptyId, processIncarnation: args.processIncarnation }
  const settleWith = (outcome: AgentPromptOutcome): void => {
    if (!state.isCurrentFlight(ptyId, flight)) {
      return
    }
    try {
      const db = args.getDb()
      if (outcome === 'submitted') {
        db?.markMailboxPointerEnterAttempted(ids, target)
        db?.settleMailboxPointerEnter(ids, target, [MAILBOX_POINTER_ENTER_ATTEMPTED])
        if (state.clearWatermark(mailboxHandle, newestSequence, ptyId)) {
          args.redrive(mailboxHandle)
        }
      } else if (outcome === 'refused') {
        db?.releaseMailboxPointerEnter(ids, target, [MAILBOX_POINTER_WRITE_ATTEMPTED])
        if (state.clearWatermark(mailboxHandle, newestSequence, ptyId)) {
          setTimeout(() => args.redrive(mailboxHandle, true), REFUSED_PROMPT_RETRY_MS).unref?.()
        }
      } else {
        // Like an unverifiable Enter: neither delivery nor a safe resend is proven.
        state.deactivateWatermark(mailboxHandle, newestSequence, ptyId)
      }
    } catch {
      // Runtime teardown can close the DB while a submission is settling.
    } finally {
      args.settle(ptyId, flight)
    }
  }
  args.channel(args.text).then(settleWith, () => settleWith('unverifiable'))
}
