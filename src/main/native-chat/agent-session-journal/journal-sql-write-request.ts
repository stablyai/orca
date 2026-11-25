import type Database from '../../sqlite/sync-database'
import type { JournalForkStages } from './journal-fork-stages'
import type { JournalSqlCommand } from './journal-sql-command'
import { applyJournalSqlMaintenance } from './journal-sql-maintenance'
import type { JournalSqlRequest, JournalSqlResponse } from './journal-sql-protocol'
import { applyJournalWriterEffect } from './journal-writer-effects'

export type JournalSqlWriteRequest = {
  id: number
  urgent?: true
  command: Exclude<JournalSqlRequest['command'], { type: 'close' } | { type: 'promote' }>
}
export type JournalSqlCommitResponse = Extract<
  JournalSqlResponse,
  { type: 'committed' | 'effects' | 'maintenance' }
>

export type JournalSqlWriteContext = {
  database: Database.Database
  executor: JournalSqlCommand
  forks: JournalForkStages
  stateDirectory: string
  /** Whether the destination a durable retirement save names is still the open database. */
  destinationCurrent: (
    operation: Extract<
      Extract<JournalSqlWriteRequest['command'], { type: 'maintenance' }>['operation'],
      { kind: 'legacy-retirement-save' }
    >
  ) => boolean
}

/** One request inside the writer's open transaction; its fork changes roll back with it. */
export async function applyJournalSqlWriteRequest(
  context: JournalSqlWriteContext,
  request: JournalSqlWriteRequest
): Promise<JournalSqlCommitResponse> {
  const { database, executor, forks, stateDirectory } = context
  const { command, id } = request
  const checkpoint = forks.checkpoint()
  try {
    if (command.type === 'maintenance') {
      if (
        command.operation.kind === 'legacy-retirement-save' &&
        !context.destinationCurrent(command.operation)
      ) {
        throw new Error('journal destination generation changed')
      }
      return {
        type: 'maintenance',
        id,
        result:
          command.operation.kind === 'fork-source-hold' ||
          command.operation.kind === 'fork-source-release' ||
          command.operation.kind === 'fork-stage-begin' ||
          command.operation.kind === 'fork-stage-page' ||
          command.operation.kind === 'fork-abort'
            ? forks.apply(command.operation, Date.now())
            : applyJournalSqlMaintenance(database, command.operation)
      }
    }
    return command.type === 'write'
      ? { type: 'committed', id, commit: await executor.apply(command.command, Date.now()) }
      : {
          type: 'effects',
          id,
          results: command.effects.map((effect) =>
            applyJournalWriterEffect(database, stateDirectory, effect)
          )
        }
  } catch (error) {
    forks.rollback(checkpoint)
    throw error
  }
}

/** A durable retirement save or a fork install raises the whole transaction's sync level. */
export function journalSqlWriteDurability(
  requests: readonly JournalSqlWriteRequest[]
): 'normal' | 'full' | 'retirement' {
  if (
    requests.some(
      (request) =>
        request.command.type === 'maintenance' &&
        request.command.operation.kind === 'legacy-retirement-save' &&
        request.command.operation.durable
    )
  ) {
    return 'retirement'
  }
  return requests.some(
    (request) => request.command.type === 'write' && request.command.command.forkInstall
  )
    ? 'full'
    : 'normal'
}
