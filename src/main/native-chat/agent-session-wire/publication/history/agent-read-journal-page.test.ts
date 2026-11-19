import { afterEach, expect, it } from 'vitest'
import {
  messageFixture,
  target
} from '../../../agent-session-journal/journal-sql-message.test-fixture'
import { readJournalDomainHistoryFrame } from '../../../agent-session-journal/journal-domain-history-page'
import { readJournalDomainItems } from '../../../agent-session-journal/journal-sql-item-reads'
import type { SqlAgentSessionJournal } from '../../../agent-session-journal/journal-sql-store'
import type { AgentJournalRenderItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { CLIENT_HISTORY_READER } from './agent-session-item-wire-form'
import { readAgentJournalPage } from './agent-read-journal-page'

const databases: ReturnType<typeof messageFixture>['db'][] = []
afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close()
  }
})

function fixture() {
  const f = messageFixture()
  databases.push(f.db)
  let beforeHistory = () => {}
  const journal: Pick<SqlAgentSessionJournal, 'history'> & {
    reads: Pick<SqlAgentSessionJournal['reads'], 'contextFloor'>
  } = {
    reads: {
      contextFloor: async () => {
        const result = readJournalDomainItems(f.db, target, { kind: 'context-floor' })
        return result.kind === 'context-floor' ? result.floor : null
      }
    },
    history: async (request) => {
      beforeHistory()
      return readJournalDomainHistoryFrame(
        f.db,
        { ...request, sessionId: target.sessionId },
        undefined,
        CLIENT_HISTORY_READER
      )
    }
  }
  return {
    ...f,
    beforeHistory: (run: () => void) => {
      beforeHistory = run
    },
    head: (sequence: number) =>
      f.db.prepare('UPDATE journal_chat_state SET last_sequence=?').run(sequence),
    read: (limit = 20, waiting = () => true) =>
      readAgentJournalPage(
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the adapter uses only these real SQLite-backed reads.
        journal as SqlAgentSessionJournal,
        { sessionId: 'chat', limit },
        waiting
      )
  }
}

function message(sequence: number, text: string, agentId?: string): AgentJournalRenderItem {
  return {
    itemId: `orca:${sequence}`,
    revision: 1,
    sequence,
    observedAt: sequence,
    body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] },
    turnScope: { kind: 'thread' },
    ...(agentId ? { agentId } : {})
  }
}

function clear(f: ReturnType<typeof fixture>) {
  f.seedItem({
    ...message(2, ''),
    body: {
      kind: 'status',
      text: 'Context cleared',
      contextClear: { operationId: 'clear', afterFence: 1, clearedAt: 2 }
    }
  })
  f.seedItem(message(3, 'new context'))
  f.db.prepare('UPDATE journal_chat_state SET last_sequence=3, context_boundary=2').run()
}

it('reads the current root context without including subagent entries', async () => {
  const f = fixture()
  f.seedItem(message(1, 'old context'))
  clear(f)
  f.seedItem(message(4, 'latest reply'))
  f.seedItem(message(5, 'child work', 'child'))
  f.head(5)

  expect(await f.read()).toEqual({
    entries: [
      { kind: 'message', role: 'system', text: 'Context cleared' },
      { kind: 'message', role: 'assistant', text: 'new context' },
      { kind: 'message', role: 'assistant', text: 'latest reply' }
    ],
    limited: false
  })
  expect(await f.read(1)).toEqual({
    entries: [{ kind: 'message', role: 'assistant', text: 'latest reply' }],
    limited: true
  })
})

it('takes the clear boundary from the history snapshot, including a clear just before it', async () => {
  const f = fixture()
  f.seedItem(message(1, 'old context'))
  f.head(1)
  f.beforeHistory(() => clear(f))
  expect(await f.read()).toEqual({
    entries: [
      { kind: 'message', role: 'system', text: 'Context cleared' },
      { kind: 'message', role: 'assistant', text: 'new context' }
    ],
    limited: false
  })
})

it('reports the byte stop and preserves an oversized-item notice as incomplete', async () => {
  const f = fixture()
  f.seedItem(message(1, 'a'.repeat(1_200_000)))
  f.seedItem(message(2, 'b'.repeat(1_200_000)))
  f.head(2)
  const page = await f.read()
  expect(page.entries).toHaveLength(1)
  expect(page.entries[0]).toEqual({
    kind: 'message',
    role: 'assistant',
    text: 'b'.repeat(1_200_000)
  })
  expect(page.limited).toBe(true)

  f.seedItem({
    ...message(3, ''),
    body: {
      kind: 'message',
      role: 'assistant',
      blocks: Array.from({ length: 100_000 }, () => ({ type: 'text', text: 'x' }))
    }
  })
  f.head(3)
  expect(await f.read()).toEqual({
    entries: [
      {
        kind: 'message',
        role: 'system',
        text: 'This part of the chat was too large to show.',
        shortened: true
      }
    ],
    limited: true
  })
})

it('finds the requested entries behind non-entry root rows', async () => {
  const f = fixture()
  f.seedItem(message(1, 'older reply'))
  f.seedItem(message(2, 'latest reply'))
  for (let sequence = 3; sequence <= 12; sequence++) {
    f.seedItem({ ...message(sequence, ''), body: { kind: 'status', text: 'working' } })
  }
  f.head(12)
  expect(await f.read(1)).toEqual({
    entries: [{ kind: 'message', role: 'assistant', text: 'latest reply' }],
    limited: true
  })
  expect(await f.read(2)).toEqual({
    entries: [
      { kind: 'message', role: 'assistant', text: 'older reply' },
      { kind: 'message', role: 'assistant', text: 'latest reply' }
    ],
    limited: false
  })
})

it('marks the page limited if its root rows contain no displayable entries', async () => {
  const f = fixture()
  f.seedItem(message(1, 'older reply'))
  for (let sequence = 2; sequence <= 250; sequence++) {
    f.seedItem({ ...message(sequence, ''), body: { kind: 'status', text: 'working' } })
  }
  f.head(250)
  expect(await f.read(1)).toEqual({ entries: [], limited: true })
})

function turn(sequence: number, state: 'running' | 'completed'): AgentJournalRenderItem {
  return {
    ...message(sequence, ''),
    itemId: 'turn-1',
    body: {
      kind: 'turn',
      turnId: 'turn-1',
      state,
      ...(state === 'completed' ? { outcome: 'success' } : {})
    }
  }
}

function reply(sequence: number, text: string): AgentJournalRenderItem {
  return { ...message(sequence, text), turnScope: { kind: 'turn', turnItemId: 'turn-1' } }
}

it('reads an open turn as working and its ended turn as done with its reply', async () => {
  const f = fixture()
  f.seedItem({
    ...message(1, ''),
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'return FINISHED' }] }
  })
  f.seedItem(turn(2, 'running'))
  f.head(2)
  expect(await f.read()).toEqual({
    entries: [{ kind: 'message', role: 'user', text: 'return FINISHED' }],
    limited: false,
    state: 'working'
  })
  f.seedItem(reply(3, 'FINISHED'))
  f.db.prepare(`DELETE FROM journal_items WHERE item_id='turn-1'`).run()
  f.seedItem(turn(4, 'completed'))
  f.head(4)
  expect(await f.read()).toEqual({
    entries: [
      { kind: 'message', role: 'user', text: 'return FINISHED' },
      { kind: 'message', role: 'assistant', text: 'FINISHED' }
    ],
    limited: false,
    state: 'done'
  })
})

it('never gives a new prompt the previous turn its done', async () => {
  const f = fixture()
  f.seedItem(reply(3, 'FINISHED'))
  f.seedItem(turn(4, 'completed'))
  f.seedSend()
  f.head(7)
  const entries = [
    { kind: 'message', role: 'assistant', text: 'FINISHED' },
    { kind: 'message', role: 'user', text: 'original' }
  ]
  expect(await f.read()).toEqual({ entries, limited: false })
  f.db.prepare(`UPDATE journal_submission_attempts SET dispatch_state='accepted'`).run()
  expect(await f.read()).toEqual({ entries, limited: false, state: 'working' })
})

it('omits the state of an ended turn whose reply is outside the page', async () => {
  const f = fixture()
  f.seedItem(reply(1, 'FINISHED'))
  for (let sequence = 2; sequence <= 250; sequence++) {
    f.seedItem({ ...message(sequence, ''), body: { kind: 'status', text: 'working' } })
  }
  f.seedItem(turn(251, 'completed'))
  f.head(251)
  expect(await f.read(1)).toEqual({ entries: [], limited: true })
})

it('does not keep a send folded into a completed turn working', async () => {
  const f = fixture()
  f.seedItem({
    ...message(1, ''),
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'first' }] }
  })
  f.seedSend()
  f.db.prepare("UPDATE journal_submission_attempts SET dispatch_state='accepted'").run()
  f.seedItem({
    ...turn(8, 'completed'),
    body: {
      kind: 'turn',
      turnId: 'turn-1',
      state: 'completed',
      outcome: 'success',
      userItemId: 'orca:1'
    }
  })
  f.seedItem(reply(9, 'BOTH ANSWERED'))
  f.head(9)
  expect(await f.read()).toMatchObject({
    state: 'done',
    entries: [
      { role: 'user', text: 'first' },
      { role: 'user', text: 'original' },
      { role: 'assistant', text: 'BOTH ANSWERED' }
    ]
  })
})

it('keeps an accepted send working when the page contains only status rows', async () => {
  const f = fixture()
  f.seedSend()
  f.db.prepare("UPDATE journal_items SET sequence=0 WHERE item_id<>'turn-1'").run()
  f.db.prepare("UPDATE journal_submission_attempts SET dispatch_state='accepted'").run()
  f.seedItem({
    ...turn(1, 'running'),
    body: { kind: 'turn', turnId: 'turn-1', state: 'running', userItemId: 'orca:send' }
  })
  for (let sequence = 8; sequence <= 260; sequence++) {
    f.seedItem({ ...reply(sequence, ''), body: { kind: 'status', text: 'working' } })
  }
  f.head(260)
  expect(await f.read()).toMatchObject({ state: 'working', entries: [], limited: true })
})

it.each([false, true])(
  'omits state for an unresolved snapshot prompt with earlier actionability %s',
  async (actionable) => {
    const f = fixture()
    f.seedItem(turn(1, 'running'))
    f.seedItem({
      ...message(2, ''),
      body: {
        kind: 'approval',
        title: 'Run command?',
        detail: null,
        options: [{ id: 'yes', label: 'Allow' }],
        resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
      }
    })
    f.head(2)
    expect(await f.read(20, () => actionable)).toEqual({
      entries: [{ kind: 'approval', text: 'Run command?', pending: actionable }],
      limited: false
    })
  }
)
