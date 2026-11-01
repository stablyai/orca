// Keep chat attachment storage/sweeps beside the journal; its database owns upload claims the sweeps honor.

import { JournalOutcomeSweeper } from '../native-chat/agent-session-journal/journal-outcome-cleanup'
import { mkdirSync } from 'node:fs'
import { AgentSessionAttachmentStore } from '../native-chat/agent-session-attachments/agent-session-attachment-store'
import {
  publishAgentSessionUploadRemoval,
  setAgentSessionAttachmentStore
} from '../native-chat/agent-session-attachments/agent-session-attachment-store-registry'
import {
  startAgentSessionAttachmentSweeps,
  type AgentSessionAttachmentSweeper
} from '../native-chat/agent-session-attachments/agent-session-attachment-sweep'
import { agentSessionAttachmentStoreRoot } from '../native-chat/agent-session-attachments/agent-session-attachment-references'
import type { JournalHostDatabase } from '../native-chat/agent-session-journal/journal-host-database'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import type { AgentSessionRecordStore } from './agent-session-record-store'

const FIRST_SWEEP_DELAY_MS = 60 * 1000
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000

let sweeper: AgentSessionAttachmentSweeper | null = null
let journalSweeper: JournalOutcomeSweeper | null = null

export function installAgentSessionAttachments(deps: {
  stateDirectory: string
  store: Pick<AgentSessionRecordStore, 'getRecord' | 'isSessionUnreadable'>
  journalDatabase: Pick<
    JournalHostDatabase,
    'readOnly' | 'isClosed' | 'db' | 'writeAutocommit' | 'transaction'
  >
  logger: StructuredAgentSessionLogger
}): void {
  stopAgentSessionAttachments()
  journalSweeper = new JournalOutcomeSweeper({
    database: () => deps.journalDatabase,
    onError: (error) =>
      deps.logger.warn('retired chat records could not be deleted', {
        scope: 'journal-outcome-sweep',
        error
      })
  }).start()
  const root = agentSessionAttachmentStoreRoot(deps.stateDirectory)
  // Before any Claude starts: Claude drops an added directory that does not exist yet, for good.
  try {
    mkdirSync(root, { recursive: true })
  } catch (error) {
    deps.logger.warn('chat attachment store could not be created', {
      scope: 'attachment-store',
      error
    })
  }
  const attachments = new AgentSessionAttachmentStore(root, {
    hasSession: (sessionId) => deps.store.getRecord(sessionId) !== null
  })
  setAgentSessionAttachmentStore(attachments)
  sweeper = startAgentSessionAttachmentSweeps(
    attachments,
    {
      database: () =>
        deps.journalDatabase.readOnly || deps.journalDatabase.isClosed
          ? null
          : deps.journalDatabase.db,
      write: (run) =>
        deps.journalDatabase.readOnly || deps.journalDatabase.isClosed
          ? undefined
          : deps.journalDatabase.writeAutocommit(run),
      recordedSessionIds: () => ({
        // Readable or not: an unreadable chat's claims still protect its uploads.
        has: (sessionId) =>
          deps.store.getRecord(sessionId) !== null || deps.store.isSessionUnreadable(sessionId)
      }),
      onUploadRemoved: publishAgentSessionUploadRemoval
    },
    {
      initialDelayMs: FIRST_SWEEP_DELAY_MS,
      intervalMs: SWEEP_INTERVAL_MS,
      onError: (error) =>
        deps.logger.warn('chat attachment sweep failed', { scope: 'attachment-sweep', error })
    }
  )
}

export function stopAgentSessionAttachments(): void {
  journalSweeper?.stop()
  journalSweeper = null
  sweeper?.stop()
  sweeper = null
  setAgentSessionAttachmentStore(null)
}
