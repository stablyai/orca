import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { readAgentSessionHistory } from '../../src/main/native-chat/agent-session-wire/agent-session-history-page.ts'
import { projectStructuredAgentSessionMessages } from '../../src/renderer/src/components/native-chat/structured-agent-session-message-projection.ts'
import { nativeChatTurnMembership } from '../../src/shared/native-chat-turn-membership.ts'
import { nativeChatRowsInDrawOrder } from '../../src/shared/native-chat-turn-grouping.ts'
import { selectNativeChatTurnStatuses } from '../../src/shared/native-chat-turn-status.ts'
import { selectStructuredAgentSettledTurns } from '../../src/shared/structured-agent-session-turn-timing.ts'
import { buildNativeChatTranscriptSlots } from '../../src/renderer/src/components/native-chat/native-chat-transcript-slots.ts'

async function snapshotWithLaterHistory() {
  const captured = JSON.parse(
    await readFile(
      new URL('../../src/main/acp/fixtures/omp-v17-compact-skip.render.jsonl', import.meta.url),
      'utf8'
    )
  )
  const items = [...captured.items]
  // Later turns are constructed test history; the skipped outcome is captured.
  for (let n = 0; n < 66; n++) {
    const sequence = 24 + n * 3
    const startedAt = 1791468228000 + n * 1000
    const userItemId = `later-user-${n}`
    const turnItemId = `later-turn-${n}`
    items.push(
      {
        itemId: userItemId,
        revision: 1,
        sequence,
        observedAt: startedAt,
        turnScope: { kind: 'thread' },
        body: {
          kind: 'message',
          role: 'user',
          blocks: [{ type: 'text', text: `later request ${n}` }]
        }
      },
      {
        itemId: turnItemId,
        revision: 2,
        sequence: sequence + 1,
        observedAt: startedAt,
        turnScope: { kind: 'thread' },
        body: {
          kind: 'turn',
          turnId: turnItemId,
          state: 'completed',
          outcome: 'success',
          userItemId,
          requestedAt: startedAt,
          startedAt,
          completedAt: startedAt + 7
        }
      },
      {
        itemId: `later-answer-${n}`,
        revision: 1,
        sequence: sequence + 2,
        observedAt: startedAt + 7,
        turnScope: { kind: 'turn', turnItemId },
        body: {
          kind: 'message',
          role: 'assistant',
          blocks: [{ type: 'text', text: `later answer ${n}` }]
        }
      }
    )
  }
  return {
    sessionId: 'session-1',
    cursor: { epoch: 'epoch-1', sequence: 221 },
    items,
    submissions: captured.submissions
  }
}

function slotsFor(page) {
  const messages = projectStructuredAgentSessionMessages(page.items, [], page.submissions)
  const membership = nativeChatTurnMembership(messages, page)
  const turnStatuses = selectNativeChatTurnStatuses(
    {},
    {
      activeTurnKey: membership.liveTurnKey ?? '',
      isWorking: false,
      thinking: false,
      settledByTurn: selectStructuredAgentSettledTurns(page.items, page.submissions)
    }
  )
  return buildNativeChatTranscriptSlots({
    messages: nativeChatRowsInDrawOrder(messages, membership.drawOrder),
    turnKeys: nativeChatRowsInDrawOrder(membership.turnKeys, membership.drawOrder),
    liveTurnKey: membership.liveTurnKey,
    receipts: new Map(),
    turnStatuses,
    turnDiffs: new Map(),
    expandedTurnKeys: new Set(),
    isWorking: false,
    lifecycleWorking: false
  })
}

it('keeps the captured skip visible when the actual 200-item history tail omits only its opener', async () => {
  const snapshot = await snapshotWithLaterHistory()
  const result = readAgentSessionHistory(
    { snapshot: () => snapshot },
    { sessionId: 'session-1', direction: 'tail', limit: 200 },
    snapshot
  )
  expect(result.ok).toBe(true)
  const page = result.page
  expect(page.items).toHaveLength(200)
  expect(page.items[0].itemId).toBe('orca:command-turn%3Acompact-1')
  expect(page.items[1].body.text).toBe('Nothing to compact (session too small)')
  expect(page.submissions).toEqual([])
  const slot = slotsFor(page).find(
    (slot) =>
      slot.kind === 'message' &&
      slot.message.blocks.some(
        (block) => block.type === 'text' && block.text === 'Nothing to compact (session too small)'
      )
  )
  expect(slot).toMatchObject({ drawsMessage: true, folded: false })
})

it('restores the captured skip after the real older-page read loads its opener', async () => {
  const snapshot = await snapshotWithLaterHistory()
  const tail = readAgentSessionHistory(
    { snapshot: () => snapshot },
    { sessionId: 'session-1', direction: 'tail', limit: 200 },
    snapshot
  ).page
  const older = readAgentSessionHistory(
    { snapshot: () => snapshot },
    { sessionId: 'session-1', direction: 'before', cursor: tail.window.nextCursor, limit: 200 },
    snapshot
  ).page
  expect(older.items.map((item) => item.itemId)).toEqual(['orca:compact-1'])
  const slots = slotsFor({
    ...tail,
    items: [...older.items, ...tail.items],
    submissions: older.submissions
  })
  const slot = slots.find(
    (slot) =>
      slot.kind === 'message' &&
      slot.message.blocks.some(
        (block) => block.type === 'text' && block.text === 'Nothing to compact (session too small)'
      )
  )
  expect(slot).toMatchObject({ drawsMessage: true, folded: false })
})

it('continues folding an ordinary warning at the same real history boundary', async () => {
  const snapshot = await snapshotWithLaterHistory()
  snapshot.items = snapshot.items.map((item) =>
    item.body.kind === 'status' ? { ...item, itemId: 'orca:ordinary-warning' } : item
  )
  const result = readAgentSessionHistory(
    { snapshot: () => snapshot },
    { sessionId: 'session-1', direction: 'tail', limit: 200 },
    snapshot
  )
  expect(result.ok).toBe(true)
  const slot = slotsFor(result.page).find(
    (slot) =>
      slot.kind === 'message' &&
      slot.message.blocks.some(
        (block) => block.type === 'text' && block.text === 'Nothing to compact (session too small)'
      )
  )
  expect(slot).toMatchObject({ drawsMessage: false, folded: true })
})
