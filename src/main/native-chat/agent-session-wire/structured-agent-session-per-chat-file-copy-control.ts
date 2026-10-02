// Starting and stopping the host's background copy of old per-chat files: once per host, whatever
// calls startup restoration again, and stopped first at teardown.

import { existsSync } from 'node:fs'
import { perChatJournalRoot } from '../agent-session-journal/journal-paths'
import {
  StructuredAgentSessionPerChatFileCopy,
  type PerChatFileCopyDeps
} from './structured-agent-session-per-chat-file-copy'
import { readStatusBackfillOwed } from './structured-agent-session-status-backfill-step'

/** Starts the job, or returns null when there is nothing it may do: a newer build's database, a
 *  records file this launch could not read (a real chat's file would look like an orphan), or no
 *  old-file root and no chat its second phase owes a status row. */
export function startStructuredAgentSessionPerChatFileCopy(
  deps: PerChatFileCopyDeps
): StructuredAgentSessionPerChatFileCopy | null {
  const { database } = deps
  if (
    database.readOnly ||
    database.legacyRecordImportOwed ||
    database.isClosed ||
    (!existsSync(perChatJournalRoot(database.stateDirectory)) &&
      readStatusBackfillOwed(deps).length === 0)
  ) {
    return null
  }
  const job = new StructuredAgentSessionPerChatFileCopy(deps)
  job.start()
  return job
}

export type PerChatFileCopyStart = {
  listedIds: readonly string[]
  /** The runtime's own startup chat work: startup restoration not yet settled, a tab listing, or a
   *  history restore owed or starting. */
  isRuntimeChatWorkActive: () => boolean
}

/** The host's one job: started once whatever calls startup restoration again, and stopped first
 *  at teardown. */
export function createStructuredAgentSessionPerChatFileCopyControl(
  base: Omit<PerChatFileCopyDeps, 'listedIds' | 'isStartupChatWorkActive'> & {
    /** The host's own startup chat work: the settle step, the startup status pass, or a history
     *  restore running. */
    isHostChatWorkActive: () => boolean
  }
): { start: (input: PerChatFileCopyStart) => void; stop: () => Promise<void> } {
  const { isHostChatWorkActive, ...deps } = base
  let started = false
  let job: StructuredAgentSessionPerChatFileCopy | null = null
  return {
    start: (input) => {
      if (started) {
        return
      }
      started = true
      try {
        job = startStructuredAgentSessionPerChatFileCopy({
          ...deps,
          listedIds: input.listedIds,
          isStartupChatWorkActive: () => input.isRuntimeChatWorkActive() || isHostChatWorkActive()
        })
      } catch (error) {
        // Bookkeeping: startup goes on, and the next launch derives what is owed again.
        deps.logger.warn('starting the copy of old chat files failed', {
          scope: 'per-chat-file-copy',
          error
        })
      }
    },
    stop: async () => {
      // Every import stops at its next batch, the job's and a restored chat's owed one alike.
      deps.database.abortImports()
      await job?.stop()
    }
  }
}
