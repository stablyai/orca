import { describe, expect, it } from 'vitest'
import {
  readMailboxDeliveryHold,
  type MailboxDeliveryHold,
  type MailboxDeliveryHoldReaders
} from './mailbox-delivery-hold'

function readers(input: {
  chat?: { awaitingHuman: boolean } | 'unreadable'
  terminalHold?: MailboxDeliveryHold | null
}): MailboxDeliveryHoldReaders {
  return {
    chatSessionFor: () => (input.chat ? 'session_1' : null),
    readChatFacts: async () =>
      input.chat && input.chat !== 'unreadable'
        ? { turnRunning: true, awaitingHuman: input.chat.awaitingHuman }
        : null,
    terminalFor: (mailbox) => (input.chat ? null : `term_for_${mailbox}`),
    readTerminalHold: () => input.terminalHold ?? null
  }
}

describe('mailbox delivery hold', () => {
  it("reports a chat worker's open prompt, and nothing for a busy chat that will take the mail", async () => {
    expect(
      await readMailboxDeliveryHold('dispatch:ctx_1', readers({ chat: { awaitingHuman: true } }))
    ).toEqual({ kind: 'prompt' })
    expect(
      await readMailboxDeliveryHold('dispatch:ctx_1', readers({ chat: { awaitingHuman: false } }))
    ).toBeNull()
    expect(
      await readMailboxDeliveryHold('dispatch:ctx_1', readers({ chat: 'unreadable' }))
    ).toBeNull()
  })

  it("passes a terminal worker's own hold through", async () => {
    const blocked = { kind: 'blocked', reason: 'permission' } as const
    expect(
      await readMailboxDeliveryHold('dispatch:ctx_1', readers({ terminalHold: blocked }))
    ).toEqual(blocked)
    expect(await readMailboxDeliveryHold('dispatch:ctx_1', readers({}))).toBeNull()
  })
})
