import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
// Context facts ride turn rows. Every kind the writer produces must replay, and
// one this build cannot read must cost the fact, never the row or the journal.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentSessionContextUsage } from '../../../shared/agent-session-context-usage'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { openJournalDatabase } from './journal-database'
import { journalDatabaseFile } from './journal-paths'
import { parseJournalRow } from './journal-row-schema'
import { createTrackedJournalOpener } from './journal-store-test-open'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'claude',
  providerHandle: { kind: 'claude', sessionId: 'claude-session', leafUuid: null }
}

const USAGE = {
  inputTokens: 1,
  cacheCreationInputTokens: 2,
  cacheReadInputTokens: 90_000,
  outputTokens: 5
}

/** One of each part and kind, as the writer builds them. */
const FACTS: AgentSessionContextUsage[] = [
  { window: { tokens: 1_000_000, capturedAt: 3 } },
  { used: { kind: 'estimate', usage: USAGE, capturedAt: 4 } },
  { used: { kind: 'unknown', capturedAt: 5 } },
  {
    used: {
      kind: 'report',
      model: 'claude-fable-5-1[1m]',
      usedTokens: 1_100_000,
      windowTokens: 1_000_000,
      percentage: 110,
      autoCompactAtTokens: 967_000,
      categories: [
        { name: 'Messages', tokens: 1_100_000 },
        { name: 'MCP tools (deferred)', tokens: 0, deferred: true }
      ],
      capturedAt: 6
    },
    window: { tokens: 1_000_000, capturedAt: 6 }
  }
]

let root: string
let clock = 1_000
const journals = createTrackedJournalOpener()

const open = () =>
  journals.open({
    identity: IDENTITY,
    journalDir: root,
    now: () => ++clock,
    mintEpoch: () => 'epoch-1'
  })

function row(ordinal: number): AgentJournalItemIdentity {
  return { provider: 'orca', clientMessageId: `row-${ordinal}` }
}

const turn = (turnId: string, contextUsage?: AgentSessionContextUsage): AgentJournalItemBody => ({
  kind: 'turn',
  turnId,
  state: 'completed',
  ...(contextUsage ? { contextUsage } : {})
})

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-context-usage-'))
  clock = 1_000
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

describe('context facts on replayed turn rows', () => {
  it('replays every part and kind the writer produces, unchanged', async () => {
    const journal = await open()
    for (const [index, facts] of FACTS.entries()) {
      await journal.appendItem(row(index), turn(`turn-${index}`, facts), {
        fence: 1,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })
    }
    const written = journal.snapshot().items.map((item) => item.body)
    await journal.close()

    const reopened = await open()
    expect(reopened.repair.malformedRows).toBe(0)
    expect(reopened.snapshot().items.map((item) => item.body)).toEqual(written)
    expect(written).toHaveLength(FACTS.length)
  })

  it('keeps a turn row whose facts it cannot read, and everything after it, minus the facts', async () => {
    const journal = await open()
    await journal.appendItem(row(0), turn('turn-0', FACTS[0]), {
      fence: 1,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
    await journal.appendItem(
      row(1),
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'after' }] },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    await journal.close()
    const opened = openJournalDatabase(journalDatabaseFile(root))
    try {
      const stored: unknown = opened.db
        .prepare('SELECT row_json FROM journal_rows WHERE seq = 2')
        .get()
      const rowJson =
        typeof stored === 'object' && stored !== null && 'row_json' in stored ? stored.row_json : ''
      const future = JSON.parse(String(rowJson))
      future.body.contextUsage = { used: { kind: 'measured-later', tokens: 'many' } }
      opened.db
        .prepare('UPDATE journal_rows SET row_json = ? WHERE seq = 2')
        .run(JSON.stringify(future))
    } finally {
      opened.db.close()
    }

    const reopened = await open()
    expect(reopened.repair.malformedRows).toBe(0)
    expect(reopened.snapshot().items.map((item) => item.body)).toEqual([
      turn('turn-0'),
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'after' }] }
    ])
  })

  it('drops unreadable facts from a settlement batch without rejecting the batch', () => {
    const parsed = parseJournalRow(
      JSON.stringify({
        v: 1,
        epoch: 'epoch-1',
        seq: 4,
        fence: 1,
        ts: 1,
        kind: 'lifecycle-batch',
        settlementId: 'stale-session:1',
        mutations: [
          {
            kind: 'item',
            itemId: 'orca:row-0',
            revision: 2,
            body: { ...turn('turn-0'), contextUsage: { window: { tokens: -1 } } }
          }
        ]
      })
    )
    expect(parsed.ok && parsed.row.kind === 'lifecycle-batch' && parsed.row.mutations).toEqual([
      { kind: 'item', itemId: 'orca:row-0', revision: 2, body: turn('turn-0') }
    ])
  })
})
