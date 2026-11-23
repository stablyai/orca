import { describe, expect, it, vi } from 'vitest'
import { BotItemsStore } from '../../../bots/bot-items-store'
import { checkedWorkerOrigin } from './bots-items-worker-origin'

vi.mock('./bots-items-caller', () => ({
  itemsWriter: (sessionId: string) => ({ bot: { id: sessionId } })
}))

describe('worker-start --item', () => {
  it('starts a worker on another agent’s open item, never on a closed one', async () => {
    const store = BotItemsStore.open(':memory:')
    const actor = { kind: 'bot', botId: 'owner', chatId: 'owner-chat' } as const
    const add = (title: string) =>
      store.add(
        {
          ownerBotId: 'owner',
          chatId: 'owner-chat',
          source: { kind: 'home', title: null },
          title,
          status: 'working',
          links: []
        },
        actor
      ).uid
    const open = add('Open')
    const closed = add('Closed')
    store.close(closed, 'done', undefined, actor)
    const remote = {
      byNumber: async (n: number) => store.byNumber(n),
      get: async (uid: string) => store.get(uid)
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the check reads only these fields of the context.
    const context = {
      orchestrationCaller: { sessionId: 'helper' },
      runtime: {
        bots: { assertEnabled: () => {} },
        botItems: { store: () => remote, owningChat: () => ({ title: null }) }
      }
    } as unknown as Parameters<typeof checkedWorkerOrigin>[1]
    await expect(checkedWorkerOrigin('bot-item:1', context)).resolves.toMatchObject({
      origin: `bot-item:${open}`
    })
    await expect(checkedWorkerOrigin('bot-item:2', context)).rejects.toThrow(/is done/)
    store.dispose()
  })
})
