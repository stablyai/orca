import { expect, it } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session-wire'
import { readAgentSessionHistory } from './agent-session-history-page'
import { AgentSessionSubscribers } from './structured-agent-session-subscribers'
import { structuredAgentSessionStopNoteIdentity } from './structured-agent-session-command-turn'
import { HISTORY_PAGE_CONTENT_BUDGET_BYTES } from './agent-session-history-page-bounds'
import { MOBILE_BRIDGE_MAX_FRAME_BYTES } from '../../../shared/mobile-bridge-frame-bytes'

import {
  fixture,
  note,
  noteId,
  ordinary,
  rows,
  scope,
  turn,
  unconfirmed
} from './agent-session-stop-note-contract-test-fixture'

it('shrinks the triggering row window without dropping the dependent note', async () => {
  await turn('running')
  await note()
  const held = fixture.journal.cursor()
  const large = {
    kind: 'message',
    role: 'assistant',
    blocks: [
      { type: 'text', text: 'x'.repeat(Math.floor(HISTORY_PAGE_CONTENT_BUDGET_BYTES * 0.6)) }
    ]
  } as const
  for (const clientMessageId of ['large-1', 'large-2']) {
    await fixture.journal.appendItem(
      { provider: 'orca', clientMessageId },
      { ...large, blocks: [...large.blocks] },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
  }
  await turn('interrupted')
  const first = readAgentSessionHistory(fixture.journal, {
    sessionId: 'session-1',
    direction: 'after',
    cursor: held,
    limit: 3
  })
  if (!first.ok) {
    throw new Error(first.reset)
  }
  expect(first.page.hasNewer).toBe(true)
  const next = readAgentSessionHistory(fixture.journal, {
    sessionId: 'session-1',
    direction: 'after',
    cursor: first.page.window.nextCursor,
    limit: 3
  })
  expect(next).toMatchObject({
    ok: true,
    page: {
      items: expect.arrayContaining([expect.objectContaining({ itemId: noteId, body: ordinary })]),
      window: { nextCursor: fixture.journal.cursor() }
    }
  })
})

it('refreshes at the exact tip using bounded frames and no durable writes', async () => {
  await turn('interrupted')
  for (let index = 0; index < 205; index += 1) {
    await fixture.journal.appendItem(
      structuredAgentSessionStopNoteIdentity(`op-${index}`),
      unconfirmed,
      {
        fence: 1,
        turnScope: scope
      }
    )
  }
  const stored = rows()
  const events: AgentSessionSubscribeEvent[] = []
  new AgentSessionSubscribers().open({
    id: 'reconnect',
    sessionId: 'session-1',
    journal: fixture.journal,
    fence: 1,
    cursor: fixture.journal.cursor(),
    emit: (event) => events.push(event)
  })
  const batches = events.flatMap((event) => (event.type === 'batch' ? [event.batch] : []))
  expect(batches.flatMap((batch) => batch.items)).toHaveLength(205)
  expect(
    batches.every(
      (batch) =>
        batch.items.length <= 200 &&
        Buffer.byteLength(JSON.stringify(batch), 'utf8') < HISTORY_PAGE_CONTENT_BUDGET_BYTES &&
        batch.cursor.sequence === fixture.journal.cursor().sequence
    )
  ).toBe(true)
  expect(
    batches
      .flatMap((batch) => batch.items)
      .every(
        (item) =>
          item.body.kind === 'status' && item.body.text === ordinary.text && !item.body.failure
      )
  ).toBe(true)
  expect(rows()).toEqual(stored)
})

it('refreshes a phone within its frames, in bounded pages', async () => {
  await turn('interrupted')
  for (let index = 0; index < 205; index += 1) {
    await fixture.journal.appendItem(
      structuredAgentSessionStopNoteIdentity(`op-${index}`),
      unconfirmed,
      {
        fence: 1,
        turnScope: scope
      }
    )
  }
  const events: AgentSessionSubscribeEvent[] = []
  new AgentSessionSubscribers().open({
    id: 'phone',
    sessionId: 'session-1',
    journal: fixture.journal,
    fence: 1,
    cursor: fixture.journal.cursor(),
    emit: (event) => events.push(event),
    boundedFrames: true
  })
  const batches = events.flatMap((event) => (event.type === 'batch' ? [event.batch] : []))
  expect(batches.filter((batch) => batch.items.length > 0)).toHaveLength(2)
  expect(batches.flatMap((batch) => batch.items)).toHaveLength(205)
  for (const event of events) {
    expect(Buffer.byteLength(JSON.stringify(event), 'utf8')).toBeLessThan(
      MOBILE_BRIDGE_MAX_FRAME_BYTES
    )
  }
})
