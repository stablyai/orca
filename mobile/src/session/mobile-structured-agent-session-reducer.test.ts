import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../../src/shared/agent-session-journal-types'
import type { AgentSessionHandoffStatus } from '../../../src/shared/agent-session-wire'
import {
  EMPTY_MOBILE_STRUCTURED_AGENT_SESSION,
  reduceMobileStructuredAgentSession
} from './mobile-structured-agent-session-reducer'

function item(id: string, sequence: number, revision = 1): AgentJournalRenderItem {
  return {
    itemId: id,
    revision,
    sequence,
    observedAt: sequence,
    body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: id }] }
  }
}

function snapshot(epoch: string, items: AgentJournalRenderItem[]) {
  return {
    type: 'snapshot' as const,
    sessionId: 'session-a',
    fence: 1,
    snapshot: { sessionId: 'session-a', cursor: { epoch, sequence: 50 }, items, submissions: [] }
  }
}

describe('mobile structured session reducer', () => {
  it('projects every stage across transfer, recovery, and return', () => {
    const handoffs: AgentSessionHandoffStatus[] = [
      { owner: 'native', direction: null, phase: 'idle', stage: null, operationId: null },
      {
        owner: 'native',
        direction: 'to-tui',
        phase: 'switching',
        stage: 'preparing',
        operationId: 'forward'
      },
      {
        owner: 'none',
        direction: 'to-tui',
        phase: 'switching',
        stage: 'old-owner-stopped',
        operationId: 'forward'
      },
      {
        owner: 'none',
        direction: 'to-tui',
        phase: 'switching',
        stage: 'new-owner-proving',
        operationId: 'forward'
      },
      {
        owner: 'tui',
        direction: null,
        phase: 'idle',
        stage: null,
        operationId: null,
        terminal: { handle: 'term-1', tabId: 'tab-1', paneKey: 'tab-1:leaf-1' }
      },
      {
        owner: 'none',
        direction: null,
        phase: 'failed',
        stage: 'manual-recovery',
        operationId: null,
        error: { message: 'Recovery required', recoverableOwner: 'none' }
      },
      {
        owner: 'tui',
        direction: null,
        phase: 'idle',
        stage: null,
        operationId: null,
        terminal: { handle: 'term-2', tabId: 'tab-1', paneKey: 'tab-1:leaf-1' }
      },
      {
        owner: 'tui',
        direction: 'to-native',
        phase: 'switching',
        stage: 'preparing',
        operationId: 'reverse'
      },
      { owner: 'native', direction: null, phase: 'idle', stage: null, operationId: null }
    ]
    let state = EMPTY_MOBILE_STRUCTURED_AGENT_SESSION
    const projected: Array<Pick<AgentSessionHandoffStatus, 'owner' | 'phase' | 'stage'>> = []

    for (const [index, handoff] of handoffs.entries()) {
      state = reduceMobileStructuredAgentSession(state, {
        type: 'event',
        event: {
          ...snapshot('epoch-a', []),
          fence: index + 1,
          snapshot: {
            ...snapshot('epoch-a', []).snapshot,
            cursor: { epoch: 'epoch-a', sequence: index }
          },
          handoff
        }
      })
      projected.push({
        owner: state.handoff!.owner,
        phase: state.handoff!.phase,
        stage: state.handoff!.stage
      })
    }

    expect(projected).toEqual(handoffs.map(({ owner, phase, stage }) => ({ owner, phase, stage })))
    expect(state.handoff).toMatchObject({ owner: 'native', phase: 'idle', stage: null })
  })

  it('boots from a bounded tail page and retains its live resume cursor', () => {
    const state = reduceMobileStructuredAgentSession(EMPTY_MOBILE_STRUCTURED_AGENT_SESSION, {
      type: 'tail-page',
      page: {
        sessionId: 'session-a',
        epoch: 'epoch-a',
        direction: 'tail',
        items: [item('recent', 40)],
        removedItemIds: [],
        submissions: [],
        window: {
          oldest: { epoch: 'epoch-a', sequence: 40 },
          newest: { epoch: 'epoch-a', sequence: 40 },
          nextCursor: { epoch: 'epoch-a', sequence: 40 }
        },
        liveCursor: { epoch: 'epoch-a', sequence: 72 },
        hasOlder: true,
        hasNewer: false
      }
    })

    expect(state.items.map((entry) => entry.itemId)).toEqual(['recent'])
    expect(state.cursor).toEqual({ epoch: 'epoch-a', sequence: 72 })
    expect(state.hasOlder).toBe(true)
  })

  it('applies revisions, removals, and cursor resume batches once', () => {
    const initial = reduceMobileStructuredAgentSession(EMPTY_MOBILE_STRUCTURED_AGENT_SESSION, {
      type: 'event',
      event: snapshot('epoch-a', [item('a', 1), item('b', 2)])
    })
    const updated = reduceMobileStructuredAgentSession(initial, {
      type: 'event',
      event: {
        type: 'batch',
        sessionId: 'session-a',
        batch: {
          cursor: { epoch: 'epoch-a', sequence: 51 },
          items: [item('b', 2, 2), item('c', 3)],
          removedItemIds: ['a'],
          submissions: []
        }
      }
    })
    expect(updated.items.map((entry) => [entry.itemId, entry.revision])).toEqual([
      ['b', 2],
      ['c', 1]
    ])
    expect(
      reduceMobileStructuredAgentSession(updated, {
        type: 'event',
        event: {
          type: 'batch',
          sessionId: 'session-a',
          batch: {
            cursor: { epoch: 'epoch-a', sequence: 50 },
            items: [item('old', 4)],
            removedItemIds: [],
            submissions: []
          }
        }
      })
    ).toBe(updated)
  })

  it('discards an older page fetched under a stale epoch', () => {
    const oldState = reduceMobileStructuredAgentSession(EMPTY_MOBILE_STRUCTURED_AGENT_SESSION, {
      type: 'event',
      event: snapshot('epoch-a', [item('new', 50)])
    })
    const reset = reduceMobileStructuredAgentSession(oldState, {
      type: 'event',
      event: { ...snapshot('epoch-b', [item('reset', 1)]), type: 'reset', reset: 'epoch_changed' }
    })
    const afterPage = reduceMobileStructuredAgentSession(reset, {
      type: 'older-page',
      requestedEpoch: 'epoch-a',
      page: {
        sessionId: 'session-a',
        epoch: 'epoch-a',
        direction: 'before',
        items: [item('stale', 1)],
        removedItemIds: [],
        submissions: [],
        window: { oldest: null, newest: null, nextCursor: { epoch: 'epoch-a', sequence: 0 } },
        hasOlder: false,
        hasNewer: true
      }
    })
    expect(afterPage).toBe(reset)
    expect(afterPage.items.map((entry) => entry.itemId)).toEqual(['reset'])
  })
})
