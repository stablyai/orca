/** The real journal an `orca agent read` suite reads: saved rows, live writes and page readers. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
  type AgentJournalItemBody
} from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import type {
  AgentJournalItemIdentity,
  AgentSessionJournalIdentity
} from '../../../../../../shared/agent-session/journal/agent-session-journal-identity'
import { agentJournalItemKey } from '../../../../../../shared/agent-session/journal/agent-session-journal-item-key'
import {
  createTrackedJournalOpener,
  insertTestJournalRow,
  openTestJournalHostDatabase,
  publishTestJournalEpoch
} from '../../../../agent-session-journal/store-lifecycle/journal-host-database-test-support'
import {
  agentSessionJournalProviderHandle,
  codexProviderHandle
} from '../../../../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import type { AgentSessionJournal } from '../../../../agent-session-journal/journal-store'
import type { JournalRow } from '../../../../agent-session-journal/durable-rows/journal-row-schema'
import { journalAgentReadIndex } from '../../../../agent-session-journal/projection/journal-agent-read-index'
import { agentChatEntryOf } from '../../../../../../shared/agent-conversations/agent-chat-entries'
import type { AgentReadEntry } from '../../../../../../shared/agent-conversations/agent-conversation-contracts'
import { readAgentJournalPage } from '../agent-read-journal-page'
import { agentJournalItemForWire } from '../agent-session-item-wire-form'

export const identity: AgentSessionJournalIdentity = {
  sessionId: 'agent-read-page',
  workspaceId: 'folder-workspace',
  hostId: 'local',
  agent: 'codex',
  providerHandle: codexProviderHandle('thread-1')
}
export const journals = createTrackedJournalOpener()
export const roots: string[] = []
export const waiting = () => true

/** Closes this suite's journals and removes their directories; run after each test. */
export async function closeAgentReadJournals() {
  vi.restoreAllMocks()
  await journals.closeAll()
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
}

export const message = (text: string): AgentJournalItemBody => ({
  kind: 'message',
  role: 'assistant',
  blocks: [{ type: 'text', text }]
})
export const status = (text: string, tone?: 'error'): AgentJournalItemBody => ({
  kind: 'status',
  text,
  ...(tone ? { tone } : {})
})
export const at = (index: number): AgentJournalItemIdentity => ({
  provider: 'codex',
  threadId: 'thread-1',
  turnId: `turn-${index}`,
  ordinal: 0
})
export const key = (index: number) => agentJournalItemKey(at(index))
export const base = {
  v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
  epoch: 'epoch-1',
  fence: 1,
  ts: 1_000
}

/** A journal saved before opening: one row per `bodies` entry (null leaves no item), then
 *  `extra` rows. Imported-style: no turn markers. */
export async function seed(
  count: number,
  body: (index: number) => AgentJournalItemBody | null,
  extra: (seq: number) => JournalRow[] = () => []
): Promise<AgentSessionJournal> {
  const root = await mkdtemp(join(tmpdir(), 'orca-agent-read-page-'))
  roots.push(root)
  const { db } = openTestJournalHostDatabase(root)
  db.exec('BEGIN IMMEDIATE')
  publishTestJournalEpoch(db, identity.sessionId, base.epoch)
  insertTestJournalRow(db, identity.sessionId, {
    ...base,
    kind: 'epoch',
    seq: 1,
    reason: 'session_created',
    providerHandle: agentSessionJournalProviderHandle(identity)
  })
  let seq = 1
  for (let index = 0; index < count; index++) {
    const item = body(index)
    if (item) {
      seq += 1
      insertTestJournalRow(db, identity.sessionId, {
        ...base,
        kind: 'item',
        seq,
        itemId: key(index),
        revision: 1,
        body: item
      })
    }
  }
  for (const row of extra(seq + 1)) {
    insertTestJournalRow(db, identity.sessionId, row)
  }
  db.exec('COMMIT')
  return journals.open({ identity, stateDirectory: root })
}

export const append = (journal: AgentSessionJournal, index: number, body: AgentJournalItemBody) =>
  journal.appendItem(at(index), body, { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE })

export const tail = (journal: AgentSessionJournal, limit: number) =>
  readAgentJournalPage(journal, { limit }, waiting)
export const textOf = (entry: AgentReadEntry) => ('text' in entry ? String(entry.text) : '')
export const texts = (page: { entries: AgentReadEntry[] }) => page.entries.map(textOf)

/** What the existing public timeline presents as agent-read entries, oldest first. */
export const publicEntries = (journal: AgentSessionJournal) =>
  journal
    .statusRead()
    .items.flatMap((item) => agentChatEntryOf(agentJournalItemForWire(item).item, waiting) ?? [])

export function resetWork(journal: AgentSessionJournal) {
  const work = journalAgentReadIndex(journal).work
  Object.assign(work, { builds: 0, builtItems: 0, upkeep: 0, nodes: 0, reads: 0 })
  return work
}

export const write = (
  journal: AgentSessionJournal,
  settlementId: string,
  items: [string, string][]
) =>
  journal.appendLifecycleBatch({
    settlementId,
    fence: 1,
    mutations: items.map(([itemId, text]) => ({
      kind: 'item' as const,
      itemId,
      body: message(text),
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    }))
  })
// The history page content budget: half the 4 MiB remote reply, less a 64 KiB envelope reserve.
export const HISTORY_CONTENT_BYTES = 2 * 1024 * 1024 - 64 * 1024
