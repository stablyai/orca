import { describe, expect, it } from 'vitest'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentJournalRenderItem
} from '../../shared/agent-session-journal-types'
import {
  selectAgentSessionPrefix,
  structuredForkEligibleItems,
  structuredForkTurnAnchors
} from '../../shared/agent-session-prefix'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'
import type { CodexStructuredSessionEvent } from './codex-structured-session-adapter'

const SESSION_ID = 'session-1'
const THREAD_ID = 'thread-abc'
const TURN_ID = 'turn-1'
const HANDLE = { provider: 'codex', threadId: THREAD_ID } as const

/** Reduces the sink's append/tombstone stream the way the journal store does, so the predicate
 *  under test sees what the real producer actually leaves behind. */
function reducingSink(): {
  sink: StructuredAgentSessionEventSink
  items: () => AgentJournalRenderItem[]
} {
  const rows = new Map<string, AgentJournalItemBody>()
  return {
    sink: {
      appendItem: (identity: AgentJournalItemIdentity, body: AgentJournalItemBody) => {
        rows.set(agentJournalItemKey(identity), body)
      },
      appendTombstone: (identity: AgentJournalItemIdentity) => {
        rows.delete(agentJournalItemKey(identity))
      },
      publish: () => {}
    },
    items: () =>
      [...rows].map(([itemId, body], index) => ({
        itemId,
        body,
        sequence: index,
        observedAt: 1
      })) as AgentJournalRenderItem[]
  }
}

function notification(method: string, params: unknown): CodexStructuredSessionEvent {
  return { type: 'notification', sessionId: SESSION_ID, threadId: THREAD_ID, method, params }
}

/** Drives the real translator through one turn. Stopping before `turn/completed` leaves the
 *  journal in the shape a live turn really has. */
function journalAfterTurn(settled: boolean, turnId: string = TURN_ID): AgentJournalRenderItem[] {
  const tap = reducingSink()
  const translator = createCodexJournalTranslator({
    sink: tap.sink,
    primaryThreadId: () => THREAD_ID
  })
  // Live user bubbles come from the submission, not the provider echo.
  tap.sink.appendItem(
    { provider: 'orca', clientMessageId: `prompt-${turnId}` },
    { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Ask' }] }
  )
  translator.handle(notification('turn/started', { turn: { id: turnId } }))
  translator.handle(
    notification('item/completed', {
      item: { type: 'agentMessage', id: `answer-${turnId}`, text: 'Answered' }
    })
  )
  if (settled) {
    translator.handle(notification('turn/completed', { turn: { id: turnId } }))
  }
  return tap.items()
}

function assistantId(items: readonly AgentJournalRenderItem[]): string {
  const answer = items.find(
    (item) => item.body.kind === 'message' && item.body.role === 'assistant'
  )
  expect(answer).toBeDefined()
  return answer!.itemId
}

describe('forking a turn the real Codex producer settled', () => {
  it('leaves no lifecycle row behind once the turn completes', () => {
    const items = journalAfterTurn(true)
    // The producer contract this feature must read: settlement TOMBSTONES the row. Nothing in the
    // product ever writes `turnLifecycle.state: 'completed'`, so a fixture that does is not a
    // model of any journal Orca can produce.
    expect(items.some((item) => item.body.kind === 'status' && item.body.turnLifecycle)).toBe(false)
    expect(items.map((item) => item.body.kind)).toEqual(['message', 'message'])
  })

  it('offers the settled turn as forkable and retains it inclusively', () => {
    const items = journalAfterTurn(true)
    const itemId = assistantId(items)
    expect(structuredForkEligibleItems(structuredForkTurnAnchors(items)).has(itemId)).toBe(true)
    const selected = selectAgentSessionPrefix({
      items,
      itemId,
      handle: HANDLE,
      boundary: 'through'
    })
    expect(selected).toMatchObject({ ok: true, throughId: TURN_ID })
    expect(selected.ok && selected.retained.map((item) => item.itemId)).toEqual(
      items.map((item) => item.itemId)
    )
  })

  it('refuses the same turn while it is still running', () => {
    const items = journalAfterTurn(false)
    const itemId = assistantId(items)
    expect(
      items.some(
        (item) => item.body.kind === 'status' && item.body.turnLifecycle?.state === 'running'
      )
    ).toBe(true)
    expect(structuredForkEligibleItems(structuredForkTurnAnchors(items)).has(itemId)).toBe(false)
    expect(
      selectAgentSessionPrefix({ items, itemId, handle: HANDLE, boundary: 'through' })
    ).toMatchObject({ ok: false, reason: 'busy' })
  })

  it('keeps a settled earlier turn forkable while a later turn runs', () => {
    const settled = journalAfterTurn(true)
    const items = [...settled, ...journalAfterTurn(false, 'turn-2')]
    expect(structuredForkEligibleItems(structuredForkTurnAnchors(items))).toEqual(
      new Set([assistantId(settled)])
    )
  })
})
