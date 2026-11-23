import { describe, expect, it, vi } from 'vitest'
import { BotItemsStore } from '../../../bots/bot-items-store'
import { BOT_ITEMS_WRITE_METHODS } from './bots-items-write-methods'
import type * as WriteSupport from './bots-items-write-support'
import type * as DispatchFacts from '../../../bots/bot-item-dispatch-facts'

const HELPER = { kind: 'bot', botId: 'helper', chatId: 'helper-chat' } as const
const OWNER = { kind: 'bot', botId: 'owner', chatId: 'owner-chat' } as const

vi.mock('./bots-items-write-support', async (actual) => ({
  ...(await actual<typeof WriteSupport>()),
  writerOf: () => ({ bot: { id: HELPER.botId }, actor: HELPER }),
  writeResult: async (_runtime: unknown, outcome: unknown) => outcome
}))
vi.mock('../../../bots/bot-item-dispatch-facts', async (actual) => ({
  ...(await actual<typeof DispatchFacts>()),
  dispatchStarterBotId: (_db: unknown, id: string) =>
    id === 'ctx_helper' ? HELPER.botId : OWNER.botId
}))

describe('bots.items.link from another agent', () => {
  it('fails a call naming someone else’s worker whole, even one the item already links', async () => {
    const store = BotItemsStore.open(':memory:')
    const { uid } = store.add(
      {
        ownerBotId: OWNER.botId,
        chatId: OWNER.chatId,
        source: { kind: 'home', title: null },
        title: 'Ship it',
        status: 'working',
        links: [{ kind: 'dispatch', ref: 'ctx_owner' }]
      },
      OWNER
    )
    const remote = {
      byNumber: async (n: number) => store.byNumber(n),
      get: async (id: string) => store.get(id),
      links: async (id: string) => store.links(id),
      link: async (...args: Parameters<BotItemsStore['link']>) => store.link(...args)
    }
    const link = BOT_ITEMS_WRITE_METHODS.find((method) => method.name === 'bots.items.link')!
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only these runtime fields.
    const context = {
      runtime: {
        botItems: { store: () => remote },
        getOrchestrationDb: () => ({ getDispatchContextById: () => undefined }),
        bots: { list: () => [] }
      }
    } as unknown as Parameters<typeof link.handler>[1]
    const call = (refs: string[]) => link.handler({ item: '1', refs }, context)

    await expect(call(['dispatch:ctx_owner', 'https://example.com/run'])).rejects.toThrow(
      /link only workers you started/
    )
    await expect(call(['dispatch:ctx_helper', 'https://example.com/run'])).resolves.toMatchObject({
      uid
    })
    expect(store.links(uid).map((entry) => entry.ref)).toEqual([
      'ctx_owner',
      'ctx_helper',
      'https://example.com/run'
    ])
    store.dispose()
  })
})
