import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  AGENT_SESSION_JOURNAL_SCHEMA_VERSION
} from '../../../shared/agent-session-journal-types'
import { serializeRemoteRuntimePayload } from '../../../shared/remote-runtime/remote-runtime-memory-limits'
import {
  createTrackedJournalOpener,
  openTestJournalHostDatabase,
  insertTestJournalRow
} from '../agent-session-journal/journal-host-database-test-support'
import type {
  JournalItemRow,
  JournalRow,
  JournalTombstoneRow
} from '../agent-session-journal/journal-row-schema'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'

export const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: codexProviderHandle('thread-1')
}

export const journals = createTrackedJournalOpener({ legacyInputs: true })

let root: string

let clock = 1_000

let epochs = 0

let journal: AgentSessionJournal

export function tick(): number {
  clock += 1
  return clock
}

export function item(ordinal: number): AgentJournalItemIdentity {
  return { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal }
}

export function body(text: string): AgentJournalItemBody {
  return { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] }
}

export async function appendItems(count: number): Promise<void> {
  for (let ordinal = 1; ordinal <= count; ordinal += 1) {
    await journal.appendItem(item(ordinal), body(`item-${ordinal}`), {
      fence: 1,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-wire-history-'))
  clock = 1_000
  epochs = 0
  journal = await journals.open({
    identity: IDENTITY,
    stateDirectory: root,
    now: tick,
    mintEpoch: () => {
      epochs += 1
      return `epoch-${epochs}`
    }
  })
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

export function serializedPageBytes(value: unknown): number {
  return Buffer.byteLength(serializeRemoteRuntimePayload(value), 'utf8')
}

export type RawSeedRow =
  | Omit<JournalItemRow, 'v' | 'epoch' | 'fence' | 'ts'>
  | Omit<JournalTombstoneRow, 'v' | 'epoch' | 'fence' | 'ts'>

/** Seed raw legacy rows, then reopen to exercise current read bounds. */

export async function reopenWithRawRows(rows: readonly RawSeedRow[]): Promise<AgentSessionJournal> {
  const full = rows.map(
    (row) =>
      ({
        ...row,
        v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
        epoch: journal.epoch,
        fence: 1,
        ts: tick()
      }) as JournalRow
  )
  await journal.close()
  const opened = openTestJournalHostDatabase(root)
  try {
    opened.db.exec('BEGIN IMMEDIATE')
    for (const row of full) {
      insertTestJournalRow(opened.db, IDENTITY.sessionId, row)
    }
    opened.db.exec('COMMIT')
  } finally {
    await opened.close()
  }
  return journals.open({ identity: IDENTITY, stateDirectory: root, now: tick })
}

export const fixture = {
  get clock() {
    return clock
  },
  set clock(value: typeof clock) {
    clock = value
  },
  get epochs() {
    return epochs
  },
  set epochs(value: typeof epochs) {
    epochs = value
  },
  get journal() {
    return journal
  },
  set journal(value: typeof journal) {
    journal = value
  },
  get root() {
    return root
  },
  set root(value: typeof root) {
    root = value
  }
}
