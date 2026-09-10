import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import type {
  AgentSessionHistoryPage,
  AgentSessionHistoryResult,
  AgentSessionSubscribeEvent
} from '../../../../shared/agent-session-wire'
import { AGENT_SESSION_TURN_ITEM_CAPABILITY } from '../../../../shared/protocol-version'
import type { AgentSessionSubscribeInput } from '../../../native-chat/agent-session-wire/structured-agent-session-subscribers'
import {
  call,
  clearStructuredHostStub,
  hostCalls,
  installStructuredHostStub,
  SESSION,
  STRUCTURED_CLIENT
} from './structured-agent-session-rpc.test-fixture'
import {
  projectTurnItemEvent,
  projectTurnItemHistory
} from './structured-agent-session-turn-item-capability'

beforeEach(installStructuredHostStub)
afterEach(clearStructuredHostStub)

const TURN = {
  turnId: 'turn-1',
  state: 'completed' as const,
  userItemId: 'user-1',
  startedAt: 10,
  completedAt: 42,
  durationMs: 30
}
const USER_ITEM: AgentJournalRenderItem = {
  itemId: 'user-1',
  revision: 1,
  sequence: 1,
  observedAt: 1,
  body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hi' }] }
}
const TURN_ITEM: AgentJournalRenderItem = {
  itemId: 'legacy:claude:session:turn-1',
  revision: 2,
  sequence: 2,
  observedAt: 2,
  body: { kind: 'turn', ...TURN }
}
const LEGACY_STATUS_ITEM: AgentJournalRenderItem = {
  ...TURN_ITEM,
  body: { kind: 'status', text: 'Claude turn completed', turnLifecycle: TURN }
}
const CURRENT_CLIENT = {
  ...STRUCTURED_CLIENT,
  clientCapabilities: [...STRUCTURED_CLIENT.clientCapabilities, AGENT_SESSION_TURN_ITEM_CAPABILITY]
}

function page(items: AgentJournalRenderItem[]): AgentSessionHistoryPage {
  return {
    sessionId: SESSION,
    epoch: 'a',
    direction: 'tail',
    items,
    removedItemIds: [],
    submissions: [],
    window: { oldest: null, newest: null, nextCursor: { epoch: 'a', sequence: 0 } },
    hasOlder: false,
    hasNewer: false
  }
}

describe('turn item capability at the RPC boundary', () => {
  it.each([
    ['legacy reader', STRUCTURED_CLIENT, LEGACY_STATUS_ITEM],
    ['current reader', CURRENT_CLIENT, TURN_ITEM],
    ['in-process reader', undefined, TURN_ITEM]
  ] as const)('projects history for a %s', async (_label, client, expected) => {
    hostCalls.history.mockReturnValue({ ok: true, page: page([USER_ITEM, TURN_ITEM]) })
    expect(
      await call('agentSession.history', { sessionId: SESSION, direction: 'tail' }, client)
    ).toMatchObject({ ok: true, result: { page: { items: [USER_ITEM, expected] } } })
  })

  it.each(['snapshot', 'batch', 'reset'] as const)(
    'downgrades the %s stream only for a legacy reader',
    async (type) => {
      hostCalls.hold = vi.fn(async () => undefined)
      hostCalls.subscribe.mockImplementation((input: AgentSessionSubscribeInput) => {
        const base = { sessionId: SESSION, fence: 1 }
        if (type === 'batch') {
          input.emit({
            ...base,
            type,
            batch: {
              cursor: { epoch: 'a', sequence: 2 },
              items: [USER_ITEM, TURN_ITEM],
              removedItemIds: [],
              submissions: []
            }
          })
        } else {
          input.emit(
            type === 'snapshot'
              ? { ...base, type, page: page([USER_ITEM, TURN_ITEM]) }
              : { ...base, type, page: page([USER_ITEM, TURN_ITEM]), reset: 'epoch_changed' }
          )
        }
        return () => {}
      })
      for (const [client, expected] of [
        [STRUCTURED_CLIENT, LEGACY_STATUS_ITEM],
        [CURRENT_CLIENT, TURN_ITEM]
      ] as const) {
        const reply = await call('agentSession.subscribe', { sessionId: SESSION }, client)
        const event = (reply.ok ? reply.result : null) as AgentSessionSubscribeEvent
        const items =
          event.type === 'batch' ? event.batch.items : 'page' in event ? event.page.items : []
        expect(items).toEqual([USER_ITEM, expected])
      }
    }
  )
})

describe('turn item projection', () => {
  const history: AgentSessionHistoryResult = { ok: true, page: page([USER_ITEM, TURN_ITEM]) }
  const snapshot: AgentSessionSubscribeEvent = {
    type: 'snapshot',
    sessionId: SESSION,
    fence: 1,
    page: page([USER_ITEM, TURN_ITEM])
  }

  it('publishes the status form with the lifecycle intact to a legacy reader', () => {
    const projected = projectTurnItemHistory(history, STRUCTURED_CLIENT)
    expect(projected.page.items).toEqual([USER_ITEM, LEGACY_STATUS_ITEM])
    // Untouched rows keep their identity; the journal's own body is never mutated.
    expect(projected.page.items[0]).toBe(USER_ITEM)
    expect(TURN_ITEM.body.kind).toBe('turn')
  })

  it.each([
    ['capable client', CURRENT_CLIENT],
    ['in-process caller', {}]
  ] as const)('hands a %s the same object back', (_label, ctx) => {
    expect(projectTurnItemHistory(history, ctx)).toBe(history)
    expect(projectTurnItemEvent(snapshot, ctx)).toBe(snapshot)
  })

  it('returns the same object when nothing needs downgrading', () => {
    const plain: AgentSessionHistoryResult = { ok: true, page: page([USER_ITEM]) }
    expect(projectTurnItemHistory(plain, STRUCTURED_CLIENT)).toBe(plain)
    const event: AgentSessionSubscribeEvent = { type: 'end' }
    expect(projectTurnItemEvent(event, STRUCTURED_CLIENT)).toBe(event)
  })
})
