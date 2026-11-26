import { expect, it } from 'vitest'
import { BotItemsStore } from './bot-items-store'

it('keeps an owner answer, item history, and outgoing mail intact when an older chat update arrives', () => {
  const store = BotItemsStore.open(':memory:')
  try {
    const itemChat = { kind: 'bot', botId: 'designer', chatId: 'item-chat' } as const
    const otherChat = { ...itemChat, chatId: 'other-chat' }
    const { uid } = store.add(
      {
        ownerBotId: itemChat.botId,
        chatId: itemChat.chatId,
        source: { kind: 'chat', title: 'Design' },
        title: 'Revise the design',
        status: 'working',
        links: []
      },
      itemChat
    )
    const ask = { status: 'needs_you', comment: 'Which of the original designs?' } as const
    store.set(uid, ask, itemChat)
    const observed = store.showRows(uid, 0, 100)
    const observedVersion = observed.rows.items[0]!.version
    store.ownerComment(uid, 'Redo the design.', { kind: 'owner' })
    const current = store.showRows(uid, 0, 100)
    const item = current.rows.items[0]!
    const mail = store.owedMail(0)
    expect(item).toMatchObject({ status: 'working', questionEvent: null })

    expect(() => store.set(uid, { ...ask, expectedVersion: observedVersion }, otherChat)).toThrow(
      expect.objectContaining({ code: 'item_changed' })
    )
    expect(store.showRows(uid, 0, 100)).toEqual(current)
    expect(store.owedMail(0)).toEqual(mail)

    store.set(
      uid,
      { expectedVersion: item.version, status: 'needs_you', comment: 'Review the new design?' },
      otherChat
    )
    expect(store.get(uid)).toMatchObject({ status: 'needs_you' })
    expect(store.owedMail(mail.through ?? 0).mails).toMatchObject([
      {
        chatId: 'item-chat',
        changes: [{ event: { data: { text: 'Review the new design?' } } }, {}]
      }
    ])

    store.set(uid, { status: 'working', comment: 'Continuing the revision.' }, otherChat)
    expect(store.get(uid)).toMatchObject({ status: 'working', questionEvent: null })
  } finally {
    store.dispose()
  }
})
