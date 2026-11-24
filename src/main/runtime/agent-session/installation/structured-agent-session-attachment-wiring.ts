// Keep chat attachment storage/sweeps beside the journal; its database owns upload claims the sweeps honor.

import { mkdirSync } from 'node:fs'
import { AgentSessionAttachmentStore } from '../../../native-chat/agent-session-attachments/agent-session-attachment-store'
import {
  publishAgentSessionUploadRemoval,
  setAgentSessionAttachmentStore
} from '../../../native-chat/agent-session-attachments/agent-session-attachment-store-registry'
import {
  startAgentSessionAttachmentSweeps,
  type AgentSessionAttachmentSweeper
} from '../../../native-chat/agent-session-attachments/agent-session-attachment-sweep'
import { agentSessionAttachmentStoreRoot } from '../../../native-chat/agent-session-attachments/agent-session-attachment-references'
import type { JournalSqlDatabase } from '../../../native-chat/agent-session-journal/database/journal-sql-database'
import { structuredAgentSessionAttachmentSweepFacts } from './structured-agent-session-attachment-sweep'
import type { StructuredAgentSessionLogger } from '../../../native-chat/agent-session-wire/host/structured-agent-session-logger'
import type { AgentSessionRecordStore } from '../records/agent-session-record-store'

const FIRST_SWEEP_DELAY_MS = 60 * 1000
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000

let sweeper: AgentSessionAttachmentSweeper | null = null

export function installAgentSessionAttachments(deps: {
  stateDirectory: string
  store: Pick<AgentSessionRecordStore, 'getRecord' | 'isSessionUnreadable'>
  journalDatabase: JournalSqlDatabase
  retainedUploadIds?: (root: string) => Promise<ReadonlySet<string>>
  logger: StructuredAgentSessionLogger
}): void {
  stopAgentSessionAttachments()
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
  setAgentSessionAttachmentStore(attachments, async (sessionId, body) => {
    if (deps.journalDatabase.readOnly || deps.journalDatabase.isClosed) {
      throw new Error('Chat attachments cannot be claimed on this host now')
    }
    await deps.journalDatabase.effects([
      { kind: 'claim', claim: { sessionId, body, required: true, now: Date.now() } }
    ])
  })
  sweeper = startAgentSessionAttachmentSweeps(
    attachments,
    {
      ...structuredAgentSessionAttachmentSweepFacts(deps.journalDatabase),
      ...(deps.retainedUploadIds ? { retainedUploadIds: () => deps.retainedUploadIds!(root) } : {}),
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
  sweeper?.stop()
  sweeper = null
  setAgentSessionAttachmentStore(null)
}
