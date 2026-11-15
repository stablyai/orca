import { JournalSqlDatabase } from '../../native-chat/agent-session-journal/database/journal-sql-database'
import { journalOpenRefusalError } from '../../native-chat/agent-session-journal/replay/journal-open-failure'
import { recordStructuredAgentSessionHostInstallRefusal } from './structured-agent-session-host-refusal'
import type { StructuredAgentSessionLogger } from '../../native-chat/agent-session-wire/host/structured-agent-session-logger'

// Repeated requests retry journal open; log each distinct failure once, including its stack.
let lastLoggedOpenFailure: string | null = null

function logOpenFailureOnce(logger: StructuredAgentSessionLogger, error: unknown): void {
  const failure =
    error instanceof Error
      ? `${'code' in error ? String(error.code) : ''}:${error.message}`
      : String(error)
  if (failure === lastLoggedOpenFailure) {
    return
  }
  lastLoggedOpenFailure = failure
  logger.error('opening the chat journal database failed', {
    scope: 'journal-database-open',
    error
  })
}

/** Record the journal refusal for the gate and throw; the next install retries.
 *  The successful record-store slot starts maintenance after installation and store construction.
 *  A load failure closes the opened owner through `closeFailedOpen` when one retains failed closes. */
export async function openStructuredAgentSessionSqlJournalDatabase(
  args: {
    stateDirectory: string
    logger: StructuredAgentSessionLogger
    closeFailedOpen?: (database: JournalSqlDatabase) => Promise<void>
  } & Pick<
    Parameters<typeof JournalSqlDatabase.open>[1],
    'writerPath' | 'readerPath' | 'onMaintenanceTick'
  >
) {
  let journalDatabase: JournalSqlDatabase | undefined
  try {
    journalDatabase = await JournalSqlDatabase.open(args.stateDirectory, {
      writerPath: args.writerPath,
      readerPath: args.readerPath,
      onMaintenanceTick: args.onMaintenanceTick,
      onMaintenanceError: (error, sessionId) =>
        args.logger.error('maintaining the chat journal database failed', {
          scope: 'journal-database-maintenance',
          sessionId,
          error
        })
    })
    const records = await journalDatabase.installRecords()
    recordStructuredAgentSessionHostInstallRefusal(null)
    lastLoggedOpenFailure = null
    return { journalDatabase, records }
  } catch (error) {
    logOpenFailureOnce(args.logger, error)
    const refusal = journalOpenRefusalError(error)
    recordStructuredAgentSessionHostInstallRefusal(refusal)
    if (journalDatabase) {
      await (args.closeFailedOpen ?? ((database) => database.close()))(journalDatabase)
    }
    throw refusal
  }
}
