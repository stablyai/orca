import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach } from 'vitest'
import type {
  AgentJournalItemIdentity,
  AgentSessionJournalIdentity
} from '../../../../../../shared/agent-session/journal/agent-session-journal-identity'
import {
  type AgentJournalItemBody,
  type AgentJournalRenderItem,
  AGENT_JOURNAL_THREAD_SCOPE
} from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import { serializeRemoteRuntimePayload } from '../../../../../../shared/remote-runtime/remote-runtime-memory-limits'
import { createTrackedJournalOpener } from '../../../../agent-session-journal/store-lifecycle/journal-host-database-test-support'
import { withTestAgentSessionDatabase } from '../../../../../runtime/agent-session/records/agent-session-record-store-test-harness'
import {
  JOURNAL_DOMAIN_ITEM_COLUMNS,
  journalDomainItemColumns
} from '../../../../agent-session-journal/journal-domain-item-read-columns'
import { journalDomainItemPlacement } from '../../../../agent-session-journal/journal-domain-item-placement'
import type {
  JournalItemRow,
  JournalTombstoneRow
} from '../../../../agent-session-journal/durable-rows/journal-row-schema'
import type { AgentSessionJournal } from '../../../../agent-session-journal/journal-store'
import { codexProviderHandle } from '../../../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'

export const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: codexProviderHandle('thread-1')
}

export const journals = createTrackedJournalOpener()

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

/** Seed pre-existing identities and their retained events for wire-bound tests. */
export async function reopenWithRawRows(rows: readonly RawSeedRow[]): Promise<AgentSessionJournal> {
  const target = { sessionId: IDENTITY.sessionId, epoch: journal.physicalCursor().epoch }
  await journal.close()
  await withTestAgentSessionDatabase(root, (db) => {
    db.exec('BEGIN IMMEDIATE')
    for (const row of rows) {
      if (row.kind === 'item') {
        const item: AgentJournalRenderItem = {
          itemId: row.itemId,
          revision: row.revision,
          sequence: row.seq,
          observedAt: tick(),
          body: row.body,
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        }
        const payload = JSON.stringify(item)
        const { values } = journalDomainItemColumns(item, payload)
        db.prepare(`INSERT INTO journal_items
          (session_id,epoch,item_id,ordinal,revision,sequence,sequence_index,owner_fence,payload_json,
           placement_json,${JOURNAL_DOMAIN_ITEM_COLUMNS.join(',')})
          VALUES(${Array.from({ length: 10 + JOURNAL_DOMAIN_ITEM_COLUMNS.length }, () => '?').join(',')})`).run(
          target.sessionId,
          target.epoch,
          item.itemId,
          row.seq,
          item.revision,
          row.seq,
          0,
          1,
          payload,
          journalDomainItemPlacement(item),
          ...values
        )
      } else {
        db.prepare('DELETE FROM journal_items WHERE session_id=? AND epoch=? AND item_id=?').run(
          target.sessionId,
          target.epoch,
          row.itemId
        )
        db.prepare(
          'INSERT INTO journal_item_tombstones(session_id,epoch,item_id,revision) VALUES(?,?,?,?)'
        ).run(target.sessionId, target.epoch, row.itemId, row.revision)
      }
      db.prepare('INSERT INTO journal_events VALUES(?,?,?,0,?)').run(
        target.sessionId,
        target.epoch,
        row.seq,
        JSON.stringify({
          items: [{ itemId: row.itemId }],
          submissions: [],
          cards: []
        })
      )
    }
    db.prepare(
      'UPDATE journal_chat_state SET last_sequence=?,retained_sequence=1 WHERE session_id=?'
    ).run(Math.max(...rows.map((row) => row.seq)), target.sessionId)
    db.exec('COMMIT')
  })
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
