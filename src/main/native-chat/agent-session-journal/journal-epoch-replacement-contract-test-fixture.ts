import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { afterEach, beforeEach } from 'vitest'
import type {
  AgentJournalItemIdentity,
  AgentJournalMessageItem,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import type { JournalHostDatabase } from './journal-host-database'
import { replaceJournalEpoch } from './journal-epoch-replacement'
import type { JournalLoad } from './journal-open'
import {
  createTrackedJournalOpener,
  openTestJournalHostDatabase
} from './journal-host-database-test-support'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { formatNativeChatFileReference } from '../../../shared/agent-image-paste'
import { agentSessionSendBodyFingerprint } from '../../../shared/structured-agent-session-send-mutation'
import * as attachmentReferences from '../agent-session-attachments/agent-session-attachment-references'

export function createFixture() {
  const IDENTITY: AgentSessionJournalIdentity = {
    sessionId: 'session-1',
    workspaceId: 'ws-1',
    hostId: 'host-1',
    agent: 'codex',
    providerHandle: codexProviderHandle('thread-1')
  }

  const PEER: AgentSessionJournalIdentity = {
    ...IDENTITY,
    sessionId: 'session-peer',
    providerHandle: codexProviderHandle('thread-peer')
  }

  let root: string

  let clock = 1_000

  let database: JournalHostDatabase

  const journals = createTrackedJournalOpener()

  function now(): number {
    clock += 1
    return clock
  }

  function storedRows(sessionId: string, epoch: string): number {
    return Number(
      database.db
        .prepare('SELECT count(*) AS total FROM journal_rows WHERE session_id = ? AND epoch = ?')
        .get(sessionId, epoch)?.total
    )
  }

  function item(ordinal: number): AgentJournalItemIdentity {
    return { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal }
  }

  function replace(input: {
    items: Parameters<typeof replaceJournalEpoch>[0]['items']
    onPublished?: (loaded: JournalLoad) => void
  }): void {
    replaceJournalEpoch({
      database,
      identity: IDENTITY,
      reason: 'legacy_import',
      fence: 1,
      items: input.items,
      queuePause: { lifted: false, liveStop: null, reopened: false },
      queue: { cards: [], receipt: { write: () => {}, committed: () => {} } },
      now,
      mintEpoch: () => `epoch-${clock}`,
      onPublished: input.onPublished ?? (() => undefined)
    })
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-journal-replace-'))
    clock = 1_000
    database = openTestJournalHostDatabase(root)
  })

  afterEach(async () => {
    try {
      await database.close()
    } catch {}
    await journals.closeAll()
    await rm(root, { recursive: true, force: true })
  })

  async function legacyInputs(count: number) {
    const existing = await journals.open({ identity: IDENTITY, stateDirectory: root })
    await existing.close()
    const files: { id: string; path: string; body: AgentJournalMessageItem }[] = []
    for (let n = 0; n < count; n++) {
      const id = randomUUID()
      const path = join(
        attachmentReferences.agentSessionAttachmentStoreRoot(root),
        id,
        'source.txt'
      )
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, 'queued source')
      const body: AgentJournalMessageItem = {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: formatNativeChatFileReference(path) }]
      }
      database.db
        .prepare(`INSERT INTO queued_messages
        (session_id, message_id, position, body_json, fingerprint, created_at, host_instance, state, hold_reason, returned_reason, consumed_as)
        VALUES (?, ?, ?, ?, ?, 0, 'earlier', ?, ?, ?, ?)`)
        .run(
          IDENTITY.sessionId,
          `queue-${n}`,
          n + 1,
          JSON.stringify(body),
          agentSessionSendBodyFingerprint(IDENTITY.sessionId, body),
          n % 2 ? 'returned' : 'waiting',
          n % 2 ? null : 'send_failed',
          n % 2 ? 'refused before' : null,
          n % 2 ? `old-${n}` : null
        )
      files.push({ id, path, body })
    }
    return files
  }

  return {
    IDENTITY,
    PEER,
    get clock() {
      return clock
    },
    set clock(value: typeof clock) {
      clock = value
    },
    get database() {
      return database
    },
    set database(value: typeof database) {
      database = value
    },
    item,
    journals,
    legacyInputs,
    now,
    replace,
    get root() {
      return root
    },
    set root(value: typeof root) {
      root = value
    },
    storedRows
  }
}
