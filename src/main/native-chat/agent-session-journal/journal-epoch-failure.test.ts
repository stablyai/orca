import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
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

const ITEM: AgentJournalItemIdentity = {
  provider: 'codex',
  threadId: 'thread-1',
  turnId: 'turn-1',
  ordinal: 0
}

const BODY: AgentJournalItemBody = {
  kind: 'message',
  role: 'assistant',
  blocks: [{ type: 'text', text: 'new epoch' }]
}

let root: string
let clock = 1_000

async function open() {
  return openAgentSessionJournal({
    identity: IDENTITY,
    journalDir: root,
    now: () => (clock += 1),
    mintEpoch: () => `epoch-${clock}`
  })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-epoch-failure-'))
  clock = 1_000
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('epoch publication failures', () => {
  it('keeps later appends on the authoritative epoch when log cleanup fails', async () => {
    const journal = await open()
    await journal.appendItem(ITEM, { ...BODY, blocks: [] }, { fence: 1 })
    const logPath = join(root, JOURNAL_LOG_FILE)
    const oldLog = await readFile(logPath, 'utf-8')

    await rm(logPath)
    await mkdir(logPath)
    await expect(journal.rollEpoch('handle_forked', 2)).rejects.toThrow()

    const snapshot = JSON.parse(await readFile(join(root, JOURNAL_SNAPSHOT_FILE), 'utf-8')) as {
      epoch: string
    }
    await rm(logPath, { recursive: true })
    await writeFile(logPath, oldLog, 'utf-8')

    const appended = await journal.appendItem(ITEM, BODY, { fence: 2 })
    expect(appended.cursor.epoch).toBe(snapshot.epoch)
    expect((await open()).snapshot().items.map((entry) => entry.body)).toEqual([BODY])
  })
})
