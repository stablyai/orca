import { describe, expect, it } from 'vitest'
import {
  readMailboxDeliveryHold,
  type ChatMailAdmitFacts,
  type MailboxDeliveryHold,
  type MailboxDeliveryHoldReaders
} from './mailbox-delivery-hold'

function readers(input: {
  chat?: ChatMailAdmitFacts | 'unreadable'
  terminalHold?: MailboxDeliveryHold | null
}): MailboxDeliveryHoldReaders {
  return {
    chatSessionFor: () => (input.chat ? 'session_1' : null),
    readChatAdmit: async () => (input.chat && input.chat !== 'unreadable' ? input.chat : null),
    terminalFor: (mailbox) => (input.chat ? null : `term_for_${mailbox}`),
    readTerminalHold: () => input.terminalHold ?? null
  }
}

const attached = { attached: true, fenced: true, refusal: null, behindPrompt: false } as const

describe('mailbox delivery hold', () => {
  it("names the chat admission's own park reasons, and a queue behind an open prompt", async () => {
    const hold = (chat: ChatMailAdmitFacts | 'unreadable') =>
      readMailboxDeliveryHold('dispatch:ctx_1', readers({ chat }))
    expect(await hold({ attached: false })).toEqual({ kind: 'detached' })
    expect(await hold({ ...attached, fenced: false })).toEqual({ kind: 'detached' })
    expect(await hold({ ...attached, refusal: 'rewind outcome unknown' })).toEqual({
      kind: 'refused',
      reason: 'rewind outcome unknown'
    })
    expect(await hold({ ...attached, behindPrompt: true })).toEqual({ kind: 'behind-prompt' })
    // A busy chat takes the mail into its normal queue; an unreadable one proves nothing.
    expect(await hold(attached)).toBeNull()
    expect(await hold('unreadable')).toBeNull()
  })

  it("passes a terminal worker's own hold through", async () => {
    const blocked = { kind: 'blocked', reason: 'permission' } as const
    expect(
      await readMailboxDeliveryHold('dispatch:ctx_1', readers({ terminalHold: blocked }))
    ).toEqual(blocked)
    expect(await readMailboxDeliveryHold('dispatch:ctx_1', readers({}))).toBeNull()
  })
})
