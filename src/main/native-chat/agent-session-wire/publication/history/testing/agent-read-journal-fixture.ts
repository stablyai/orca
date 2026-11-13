/** The real journal an `orca agent read` suite reads: saved rows, live writes and page readers. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, vi } from 'vitest'
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
import {
  readAgentJournalPage,
  type AgentReadJournalPage,
  type AgentReadJournalPosition
} from '../agent-read-journal-page'
import { agentJournalItemForWire } from '../agent-session-item-wire-form'
import { encodeReadCursor } from '../../../../../runtime/agent-conversations/agent-read-cursor'

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

export const tail = (journal: AgentSessionJournal, limit: number) => {
  const page = readAgentJournalPage(journal, { limit }, waiting)
  if (!page.ok) {
    throw new Error('expected a page')
  }
  return page
}
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

/** Pages forward from `after` until a page isn't limited. */
export function readForward(
  journal: AgentSessionJournal,
  limit: number,
  from: AgentReadJournalPosition
) {
  let after = from
  const pages: Extract<AgentReadJournalPage, { ok: true }>[] = []
  for (let page = 0; page < 20; page++) {
    const next = readAgentJournalPage(journal, { limit, after }, waiting)
    if (!next.ok) {
      throw new Error('expected a page')
    }
    pages.push(next)
    after = next.next
    if (!next.limited) {
      break
    }
  }
  return { entries: pages.flatMap((page) => page.entries), pages, after }
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
export const remove = (journal: AgentSessionJournal, ...itemIds: string[]) =>
  journal.appendLifecycleBatch({
    settlementId: `remove ${itemIds.join(' ')}`,
    fence: 1,
    mutations: itemIds.map((itemId) => ({ kind: 'tombstone' as const, itemId }))
  })
export const abc: [string, string][] = [
  ['a', 'a'],
  ['b', 'b'],
  ['c', 'c']
]

/** Reads forward a page at a time, running `between[n]` after page n, through to the head. */
export async function readThrough(
  journal: AgentSessionJournal,
  limit: number,
  from: AgentReadJournalPosition,
  between: (() => Promise<unknown>)[]
) {
  let after = from
  const pages: Extract<AgentReadJournalPage, { ok: true }>[] = []
  for (let page = 0; page < 40; page++) {
    const next = readAgentJournalPage(journal, { limit, after }, waiting)
    if (!next.ok) {
      throw new Error('expected a page')
    }
    pages.push(next)
    after = next.next
    await between[page]?.()
    if (!next.limited && page >= between.length) {
      break
    }
  }
  return { pages, read: pages.flatMap(texts), after }
}

/** A row written after one reply, the position before it, and its sequence. */
export async function rowAfterReply(items: [string, string][]) {
  const journal = await seed(1, () => message('before'))
  const start: AgentReadJournalPosition = { cursor: journal.cursor() }
  await write(journal, 'row', items)
  const row = journal.cursor().sequence
  /** The row is still there to continue, so a reset can't pass for a read. */
  const stillThere = () => {
    const source = journal.readSince(start.cursor)
    expect(source.ok && source.rows.some((stored) => stored.seq === row)).toBe(true)
  }
  return { journal, start, stillThere }
}

/** An RPC reply as the read method sends it, with the encoded cursor. */
export function reply(page: Extract<AgentReadJournalPage, { ok: true }>) {
  const cursor = encodeReadCursor({
    v: 2,
    id: 'codex_0b8f2a4e_6c1d_4f7a_9e3b_5a2c8d1f0e47',
    s: 'chat',
    session: identity.sessionId,
    journal: page.next.cursor,
    ...(page.next.partial ? { partial: page.next.partial } : {})
  })
  return {
    json: JSON.stringify({ id: 'r', ok: true, result: { entries: page.entries, cursor } }),
    cursor
  }
}

// The history page content budget: half the 4 MiB remote reply, less a 64 KiB envelope reserve.
export const HISTORY_CONTENT_BYTES = 2 * 1024 * 1024 - 64 * 1024
