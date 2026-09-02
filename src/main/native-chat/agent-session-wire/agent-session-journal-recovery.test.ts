// Recovery drives the real journal loader against real on-disk damage: a hole
// punched in the log, and a row stamped with a schema this host cannot read.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  AgentJournalItemIdentity,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { openAgentSessionJournal } from '../agent-session-journal/journal-store-factory'
import {
  openAgentSessionJournalWithRecovery,
  providerHistoryId,
  recoveryJournalDir
} from './agent-session-journal-recovery'

const CODEX_SESSION = '019fd532-7c11-7a90-b6de-4e1a2c3d5f60'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: CODEX_SESSION,
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: CODEX_SESSION }
}

const CODEX_LINES = [
  {
    type: 'session_meta',
    timestamp: '2026-08-05T10:00:00.000Z',
    payload: {
      id: CODEX_SESSION,
      session_id: CODEX_SESSION,
      cwd: '/Users/dev/project',
      originator: 'codex_cli_rs',
      cli_version: '0.146.1'
    }
  },
  {
    type: 'event_msg',
    timestamp: '2026-08-05T10:00:02.000Z',
    payload: { type: 'user_message', message: 'add a retry', kind: 'plain' }
  },
  {
    type: 'event_msg',
    timestamp: '2026-08-05T10:00:05.000Z',
    payload: { type: 'agent_message', message: 'On it.' }
  }
]

let root: string
let journalDir: string
let historyFilePath: string

function item(ordinal: number): AgentJournalItemIdentity {
  return { provider: 'codex', threadId: CODEX_SESSION, turnId: 'turn-1', ordinal }
}

/** Fills a journal with `count` items and hands back the raw log lines. */
async function seedJournal(count: number): Promise<string[]> {
  const journal = await openAgentSessionJournal({ identity: IDENTITY, journalDir })
  for (let ordinal = 1; ordinal <= count; ordinal += 1) {
    await journal.appendItem(
      item(ordinal),
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: `item-${ordinal}` }] },
      { fence: 1 }
    )
  }
  const raw = await readFile(join(journalDir, 'log.jsonl'), 'utf-8')
  return raw.split('\n').filter((line) => line.trim().length > 0)
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-wire-recovery-'))
  journalDir = join(root, 'journal')
  historyFilePath = join(root, 'rollout.jsonl')
  await writeFile(
    historyFilePath,
    `${CODEX_LINES.map((line) => JSON.stringify(line)).join('\n')}\n`,
    'utf-8'
  )
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('providerHistoryId', () => {
  it('uses the provider handle, never the Orca session id', () => {
    expect(providerHistoryId({ kind: 'codex', threadId: 'thread-9' })).toBe('thread-9')
    expect(providerHistoryId({ kind: 'claude', sessionId: 'sess-9', leafUuid: null })).toBe(
      'sess-9'
    )
  })
})

describe('openAgentSessionJournalWithRecovery', () => {
  it('opens a healthy journal untouched', async () => {
    await seedJournal(2)
    const opened = await openAgentSessionJournalWithRecovery({
      identity: IDENTITY,
      journalDir,
      fence: 1,
      historyFilePath
    })
    expect(opened.recovery).toBeNull()
    expect(opened.journal.snapshot().items).toHaveLength(2)
  })

  it('rebuilds a holed journal in place on a fresh epoch', async () => {
    const lines = await seedJournal(3)
    const holed = lines.filter((_line, index) => index !== 1)
    await writeFile(join(journalDir, 'log.jsonl'), `${holed.join('\n')}\n`, 'utf-8')

    const opened = await openAgentSessionJournalWithRecovery({
      identity: IDENTITY,
      journalDir,
      fence: 1,
      historyFilePath
    })
    expect(opened.recovery).toMatchObject({ trigger: 'journal_corrupt', reset: 'epoch_changed' })
    expect(opened.recovery?.imported).toBeGreaterThan(0)
    expect(opened.journal.isReadOnly).toBe(false)
    // The rebuilt timeline is the only content of its epoch — nothing from the
    // damaged prefix survives into it.
    const texts = opened.journal.snapshot().items.map((entry) => JSON.stringify(entry.body))
    expect(texts.some((text) => text.includes('item-1'))).toBe(false)
    expect(texts.some((text) => text.includes('add a retry'))).toBe(true)
  })

  it('reconstructs a future-schema journal into a schema-scoped sibling, never in place', async () => {
    const lines = await seedJournal(1)
    await writeFile(
      join(journalDir, 'log.jsonl'),
      `${lines.join('\n')}\n${JSON.stringify({ v: 99, seq: 2, epoch: 'e', kind: 'item' })}\n`,
      'utf-8'
    )

    const opened = await openAgentSessionJournalWithRecovery({
      identity: IDENTITY,
      journalDir,
      fence: 1,
      historyFilePath
    })
    expect(opened.recovery).toMatchObject({
      trigger: 'schema_unreadable',
      reset: 'schema_unreadable'
    })
    expect(opened.recovery?.imported).toBeGreaterThan(0)

    // The unreadable journal is left exactly as found; a newer host still owns it.
    const untouched = await readFile(join(journalDir, 'log.jsonl'), 'utf-8')
    expect(untouched).toContain('"v":99')
    const sibling = await readFile(join(recoveryJournalDir(journalDir), 'log.jsonl'), 'utf-8')
    expect(sibling).toContain('add a retry')
  })

  it('still opens the session when provider history cannot be read', async () => {
    const lines = await seedJournal(3)
    const holed = lines.filter((_line, index) => index !== 2)
    await writeFile(join(journalDir, 'log.jsonl'), `${holed.join('\n')}\n`, 'utf-8')

    const opened = await openAgentSessionJournalWithRecovery({
      identity: IDENTITY,
      journalDir,
      fence: 1,
      historyFilePath: join(root, 'missing.jsonl')
    })
    expect(opened.recovery).toMatchObject({ trigger: 'journal_corrupt', imported: 0 })
    expect(opened.recovery?.error).toBeTruthy()
    // A missing provider transcript must not clear the intact journal prefix.
    expect(opened.journal.snapshot().items).toHaveLength(1)
  })
})
