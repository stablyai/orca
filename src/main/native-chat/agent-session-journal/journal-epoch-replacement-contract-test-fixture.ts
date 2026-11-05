import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { afterEach, beforeEach } from 'vitest'
import type {
  AgentJournalItemIdentity,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalHostDatabase } from './journal-host-database'
import {
  createTrackedJournalOpener,
  openTestJournalHostDatabase,
  seedTestLegacyQueueRows
} from './journal-host-database-test-support'
import type { QueuedMessageRow } from './queued-message-table'
import { codexProviderHandle } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import { formatNativeChatFileReference } from '../../../shared/agent-image-paste'
import { agentSessionSendBodyFingerprint } from '../../../shared/agent-session/requests/structured-agent-session-send-mutation'
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

  async function storedRows(sessionId: string, epoch: string): Promise<number> {
    return database.read(async (read) =>
      Number(
        (
          await read
            .prepare(
              'SELECT count(*) AS total FROM journal_rows WHERE session_id = ? AND epoch = ?'
            )
            .get(sessionId, epoch)
        )?.total
      )
    )
  }

  function item(ordinal: number): AgentJournalItemIdentity {
    return { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal }
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-journal-replace-'))
    clock = 1_000
    database = await openTestJournalHostDatabase(root)
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
    const queueRows: QueuedMessageRow[] = []
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
      queueRows.push({
        messageId: `queue-${n}`,
        position: n + 1,
        body,
        fingerprint: agentSessionSendBodyFingerprint(IDENTITY.sessionId, body),
        state: n % 2 ? 'returned' : 'waiting',
        holdReason: n % 2 ? null : 'send_failed',
        returnedReason: n % 2 ? 'refused before' : null,
        returnedRejection: null,
        consumedAs: n % 2 ? `old-${n}` : null,
        queuedAt: null
      })
      files.push({ id, path, body })
    }
    await seedTestLegacyQueueRows(database, IDENTITY.sessionId, queueRows)
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
    get root() {
      return root
    },
    set root(value: typeof root) {
      root = value
    },
    storedRows
  }
}
