import { runJournalSqlCommand } from './journal-sql-command-dispatch'
import type { JournalForkStages } from './journal-fork-stages'
import { journalForkStageHeld } from './journal-fork-stage-state'
import { beginJournalRequestEvents } from './journal-writer-request-events'
import type Database from '../../sqlite/sync-database'

import type { JournalWriterCommand } from './journal-writer-command'
import type { JournalWriterCommit } from './journal-writer-changes'

/** Every command decides against current rows at its position on the sole writer. */
export class JournalSqlCommand {
  constructor(
    private readonly db: Database.Database,
    private readonly stateDirectory: string,
    private readonly forks?: JournalForkStages
  ) {}

  async apply(command: JournalWriterCommand, now: number): Promise<JournalWriterCommit> {
    const finish = beginJournalRequestEvents(this.db, command.facts?.stopSettle)
    try {
      if (command.operation.kind === 'fork-install' && !command.forkInstall) {
        throw new Error('fork install requires a completed private stage')
      }
      if (!command.forkInstall && journalForkStageHeld(this.db, command.target.sessionId)) {
        throw new Error('fork stage owns this child journal')
      }
      const installation = command.forkInstall
      if (installation) {
        if (!this.forks) {
          throw new Error('fork installation requires its live writer owner')
        }
        command = this.forks.install(command, installation)
      }
      const result = await runJournalSqlCommand(this.db, this.stateDirectory, command, now)
      const commit = installation
        ? {
            ...result,
            forkInstalled: {
              epoch: command.target.epoch,
              boundary:
                installation.lastItemId === null
                  ? { kind: 'start' as const }
                  : { kind: 'item' as const, itemId: installation.lastItemId }
            }
          }
        : result
      const requestEvents = finish()
      return {
        ...commit,
        requestEvents:
          command.operation.kind === 'epoch-replace' ||
          command.operation.kind === 'context-rewind' ||
          command.operation.kind === 'rewind-cut'
            ? []
            : requestEvents
      }
    } finally {
      finish()
    }
  }
}
