import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { JOURNAL_LOG_FILE, JOURNAL_SNAPSHOT_FILE } from './journal-log-file'
import { openAgentSessionJournal } from './journal-store'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: 'thread-1' }
}

let root: string
let clock = 1_000

function body(text: string): AgentJournalItemBody {
  return { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] }
}

async function open() {
  return openAgentSessionJournal({
    identity: IDENTITY,
    journalDir: root,
    now: () => ++clock,
    mintEpoch: () => `epoch-${clock}`
  })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-validation-'))
  clock = 1_000
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('persisted journal validation', () => {
  it('does not admit a malformed item body into reducer state', async () => {
    const journal = await open()
    const malformed = JSON.stringify({
      v: 1,
      kind: 'item',
      epoch: journal.epoch,
      seq: 2,
      fence: 1,
      ts: 1_002,
      itemId: 'malformed',
      revision: 1,
      body: null
    })
    const logPath = join(root, JOURNAL_LOG_FILE)
    await writeFile(logPath, `${await readFile(logPath, 'utf-8')}${malformed}\n`, 'utf-8')

    const reopened = await open()
    expect(reopened.snapshot().items).toEqual([])
    await expect(reopened.compact(1)).resolves.toBeUndefined()
  })

  it('rebuilds from the log when a snapshot contains a malformed render item', async () => {
    const journal = await open()
    await journal.appendItem(
      { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal: 0 },
      body('valid'),
      { fence: 1 }
    )
    const expected = journal.snapshot()
    await journal.compact(1)

    const snapshotPath = join(root, JOURNAL_SNAPSHOT_FILE)
    const snapshot = JSON.parse(await readFile(snapshotPath, 'utf-8')) as {
      items: { body: unknown }[]
    }
    snapshot.items[0]!.body = null
    await writeFile(snapshotPath, JSON.stringify(snapshot), 'utf-8')

    const reopened = await open()
    expect(reopened.snapshot()).toEqual(expected)
    await expect(reopened.compact(1)).resolves.toBeUndefined()
  })
})
