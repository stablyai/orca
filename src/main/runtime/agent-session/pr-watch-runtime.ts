// Owns the host's CI-line watches apart from the chat host: they start once startup settles, so a
// PR is watched (and follow-up registrations read) whether or not any chat was opened.

import { attachPRWatchSource } from '../../github/pr-watch/pr-watch-seams'
import { PRWatchService } from '../../github/pr-watch/pr-watch-service'
import { readPRChatActionRecords, readPROwnerChat } from '../../github/pr-watch/pr-watch-tables'
import type { PRWatchServiceDeps, PRWatchWorkspace } from '../../github/pr-watch/pr-watch-types'
import type { JournalRow } from '../../native-chat/agent-session-journal/journal-row-schema'
import type { AgentSessionJournal } from '../../native-chat/agent-session-journal/journal-store'
import type { StructuredAgentSessionLogger } from '../../native-chat/agent-session-wire/structured-agent-session-logger'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import { openAgentSessionRecordStoreOnce } from './records/agent-session-record-store-slot'

export type PRWatchRuntimeDeps = {
  stateDirectory: string
  legacySessionTabIds: readonly string[]
  hostId: string
  logger: StructuredAgentSessionLogger
  resolveWorkspace: (workspaceId: string) => Promise<PRWatchWorkspace | 'not-git' | null>
  resolveRepo: PRWatchServiceDeps['resolveRepo']
}

let generation = 0
let starting: Promise<void> | null = null
let running: { service: PRWatchService; detach: () => void } | null = null

/** The open chat's journal, if any: the publication feed hands a new observer it at once. */
function openChatJournal(chatId: string): AgentSessionJournal | null {
  let journal: AgentSessionJournal | null = null
  getStructuredAgentSessionHost()?.observeConversationPublications(chatId, {
    next: (hint) => (journal ??= hint.journal),
    error: () => {}
  })?.()
  return journal
}

/** Idempotent; reuses the record store slot the chat host opens, so nothing opens twice. */
export function startPRWatchRuntime(deps: PRWatchRuntimeDeps): Promise<void> {
  const startedIn = generation
  starting ??= (async () => {
    const { store, journalDatabase } = await openAgentSessionRecordStoreOnce({
      stateDirectory: deps.stateDirectory,
      legacySessionTabIds: [...deps.legacySessionTabIds],
      hostId: deps.hostId,
      logger: deps.logger
    })
    if (startedIn !== generation) {
      return
    }
    const service = new PRWatchService({
      database: journalDatabase,
      chatExists: (chatId) => store.getConversation(chatId) != null,
      chatFence: (chatId) => store.getConversation(chatId)?.currentFence ?? null,
      // Folder workspaces have no checkout to read a PR through, so their chats get no lines.
      chatWorkspace: async (chatId) => {
        const location = store.getConversation(chatId)?.location
        if (!location) {
          return null
        }
        return location.workspaceKind === 'git-worktree'
          ? deps.resolveWorkspace(location.workspaceId).catch(() => null)
          : 'not-git'
      },
      resolveRepo: deps.resolveRepo,
      openJournal: openChatJournal,
      logger: deps.logger
    })
    const detach = attachPRWatchSource({
      // No follow-up source registers in this build yet.
      registrationsSettled: Promise.resolve(),
      resolveRepo: deps.resolveRepo,
      pullRequestActionsFor: (prKey) =>
        journalDatabase.isClosed ? [] : readPRChatActionRecords(journalDatabase.db, prKey),
      ownerChatFor: (prKey) =>
        journalDatabase.isClosed ? null : readPROwnerChat(journalDatabase.db, prKey)
    })
    running = { service, detach }
    await service.start()
  })().catch((error: unknown) => {
    starting = null
    deps.logger.warn('starting CI-line watches failed', { scope: 'pr-watch', error })
  })
  return starting
}

/** Before the journal database closes; the next start rebuilds from the saved tables. */
export function stopPRWatchRuntime(): void {
  generation += 1
  running?.detach()
  running?.service.stop()
  running = null
  starting = null
}

export function observePRWatchCommittedRows(
  sessionId: string,
  journal: AgentSessionJournal,
  rows: readonly JournalRow[] | undefined
): void {
  // Before watches start, captured obligations simply wait in their table for the first drain.
  running?.service.observeCommittedRows(sessionId, journal, rows)
}
