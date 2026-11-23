import { describe, expect, it } from 'vitest'
import { BOTS_ITEM_WAITING_CAPABILITY } from '../../../../shared/bot-runtime-capabilities'
import { makeTestBotItem } from '../../../../shared/bots/bot-item.test-fixture'
import type { BotItemEvent } from '../../../../shared/bots/bot-items'
import { remoteRuntimeClientCapabilities } from '../../../../shared/remote-runtime/remote-runtime-client-capabilities'
import { BotItemsStore } from '../../../bots/bot-items-store'
import type { RpcContext } from '../core'
import {
  botItemCountsForClient,
  botItemEventsForClient,
  botItemsForClient,
  botItemStatusesForClient
} from './bots-items-waiting-compat'
import { writeResult } from './bots-items-write-support'
import type { BotItemWriter } from './bots-items-caller'

const older = { clientKind: 'mobile' as const, clientCapabilities: [] }
const current = {
  clientKind: 'mobile' as const,
  clientCapabilities: [BOTS_ITEM_WAITING_CAPABILITY]
}

describe('Waiting for a client that predates it', () => {
  const item = makeTestBotItem(4, { status: 'waiting', wait: { text: 'CI on #9', at: 1 } })
  const moved: BotItemEvent = {
    id: 'e5',
    kind: 'status',
    actor: { kind: 'orca', why: 'usage-limit' },
    data: { from: 'working', to: 'waiting', note: 'CI on #9' },
    at: 1
  }
  const counts = { working: 2, waiting: 3, needs_you: 1 }

  it('reads as In progress, so the row is kept, and as Waiting to one that reads it', () => {
    expect(botItemsForClient([item], older)[0]!.status).toBe('working')
    expect(botItemCountsForClient(counts, older)).toEqual({ working: 5, needs_you: 1 })
    expect(botItemEventsForClient([moved], older)[0]!.data).toMatchObject({ to: 'working' })
    expect(botItemStatusesForClient(['working'], older)).toEqual(['working', 'waiting'])
    expect(botItemsForClient([item], current)[0]!.status).toBe('waiting')
    expect(botItemCountsForClient(counts, current)).toEqual(counts)
    expect(botItemStatusesForClient(['working'], current)).toEqual(['working'])
  })

  it('is read by the paired desktop and phone', () => {
    expect(remoteRuntimeClientCapabilities()).toContain(BOTS_ITEM_WAITING_CAPABILITY)
  })

  it('reads as In progress in what a write answers an older client', async () => {
    const store = BotItemsStore.open(':memory:')
    const actor = { kind: 'bot' as const, botId: 'bot', chatId: 'home' }
    const { uid } = store.add(
      {
        ownerBotId: 'bot',
        chatId: 'home',
        source: { kind: 'home', title: null },
        title: 'Ship it',
        status: 'working',
        links: []
      },
      actor
    )
    store.set(uid, { status: 'waiting', note: 'CI on #9' }, actor)
    const runtime = {
      botItems: {
        store: () => ({ get: async (id: string) => store.get(id) }),
        changed: () => {},
        views: async (records: { status: string }[]) =>
          records.map((record) => makeTestBotItem(1, { status: record.status as 'waiting' })),
        sendOwedMail: async () => {}
      }
    }
    const answer = (context: Pick<RpcContext, 'clientKind' | 'clientCapabilities'>) =>
      writeResult(
        { ...context, runtime: runtime as unknown as RpcContext['runtime'] },
        { uid, eventId: null },
        {} as BotItemWriter
      )
    expect((await answer(older)).item.status).toBe('working')
    expect((await answer(current)).item.status).toBe('waiting')
    store.dispose()
  })
})
