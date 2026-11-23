import { describe, expect, it } from 'vitest'
import { BOTS_ITEM_WAITING_CAPABILITY } from '../../../../shared/bot-runtime-capabilities'
import { makeTestBotItem } from '../../../../shared/bots/bot-item.test-fixture'
import type { BotItemEvent } from '../../../../shared/bots/bot-items'
import {
  botItemCountsForClient,
  botItemEventsForClient,
  botItemsForClient
} from './bots-items-waiting-compat'

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
    const older = { clientKind: 'mobile' as const, clientCapabilities: [] }
    expect(botItemsForClient([item], older)[0]!.status).toBe('working')
    expect(botItemCountsForClient(counts, older)).toEqual({ working: 5, needs_you: 1 })
    expect(botItemEventsForClient([moved], older)[0]!.data).toMatchObject({ to: 'working' })
    const current = {
      clientKind: 'mobile' as const,
      clientCapabilities: [BOTS_ITEM_WAITING_CAPABILITY]
    }
    expect(botItemsForClient([item], current)[0]!.status).toBe('waiting')
    expect(botItemCountsForClient(counts, current)).toEqual(counts)
  })
})
