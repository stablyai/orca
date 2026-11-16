import {
  journalOrchestrationAttached,
  markJournalOrchestrationAttached,
  forgetJournalOrchestrationAttachment
} from './journal-failure-authority'
import { JournalForkStages } from './journal-fork-stages'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parentPort, workerData } from 'node:worker_threads'
import type Database from '../../sqlite/sync-database'
import {
  initializeJournalDomainDatabase,
  journalDomainDatabasePath,
  openJournalDomainDatabase
} from './database/journal-domain-database'
import { JournalCheckpointOwner } from './database/journal-checkpoint-owner'
import { JournalSqlBatch, JournalSqlBatchError } from './journal-sql-batch'
import { JournalSqlCommand } from './journal-sql-command'
import { takeJournalSqlReadyBatch } from './journal-sql-ready-batch'
import { applyJournalWriterEffect } from './journal-writer-effects'
import { journalSqlFailure } from './journal-sql-failure'
import type { JournalSqlRequest, JournalSqlResponse } from './journal-sql-protocol'
import { assertJournalWritable } from './writing/journal-write-guards'
import { applyJournalSqlMaintenance } from './journal-sql-maintenance'

if (
  !parentPort ||
  !workerData ||
  typeof workerData.filename !== 'string' ||
  typeof workerData.stateDirectory !== 'string'
) {
  throw new Error('journal SQL owner requires a path and parent port')
}
const port = parentPort
const stateDirectory: string = workerData.stateDirectory
let db: Database.Database | undefined
let batch: JournalSqlBatch | undefined
let commands: JournalSqlCommand | undefined
let forks: JournalForkStages | undefined
let checkpoint: JournalCheckpointOwner | undefined
let checkpointClosing: Promise<void> | undefined
let readOnly = true
let fault: unknown
let closing = false
let scheduled = false
const queue: JournalSqlRequest[] = []

async function open(): Promise<void> {
  try {
    mkdirSync(dirname(workerData.filename), { recursive: true })
    if (workerData.filename === journalDomainDatabasePath(stateDirectory)) {
      await initializeJournalDomainDatabase(stateDirectory)
    }
    const opened = openJournalDomainDatabase(workerData.filename)
    db = opened.db
    readOnly = opened.readOnly
    forks = new JournalForkStages(db, stateDirectory)
    commands = new JournalSqlCommand(db, stateDirectory, forks)
    if (!readOnly) {
      checkpoint = new JournalCheckpointOwner(db, workerData.filename)
    }
    batch = new JournalSqlBatch(db, checkpoint)
    reply({ type: 'ready', readOnly })
  } catch (error) {
    fault = error
    reply({
      type: 'failed',
      outcome: 'not-dispatched',
      fatal: true,
      error: journalSqlFailure(error)
    })
    db?.close()
    port.close()
  }
}
void open()

port.on('message', (request: JournalSqlRequest) => {
  if (closing || !db) {
    reply({
      type: 'failed',
      id: request.id,
      outcome: 'not-dispatched',
      error: journalSqlFailure(new Error('journal SQL owner is closing'))
    })
    return
  }
  if (request.command.type === 'close') {
    closing = true
    checkpointClosing = checkpoint?.close()
    void checkpointClosing?.catch(() => undefined)
  }
  queue.push(request)
  if (!scheduled) {
    scheduled = true
    setImmediate(() => {
      void drain()
    })
  }
})

function reply(response: JournalSqlResponse): void {
  port.postMessage(response)
}

type WriteRequest = {
  id: number
  command: Exclude<JournalSqlRequest['command'], { type: 'close' }>
}
type CommitResponse = Extract<JournalSqlResponse, { type: 'committed' | 'effects' | 'maintenance' }>
/** Bound ready work before opening a transaction, then yield after its acknowledgements. */
async function drain(): Promise<void> {
  const pending = takeJournalSqlReadyBatch(queue)
  const writes = pending.filter(
    (request): request is WriteRequest => request.command.type !== 'close'
  )
  const close = pending.find((request) => request.command.type === 'close')
  const database = db
  if (writes.length > 0 && database && batch && commands) {
    const executor = commands
    let responses: JournalSqlResponse[] = []
    try {
      if (fault) {
        throw fault
      }
      assertJournalWritable(readOnly, 'database')
      const authorityPath = join(stateDirectory, 'orchestration.db')
      const controlsInput = writes.some(
        ({ command }) =>
          command.type === 'write' &&
          (['failure-resume', 'automatic-submission', 'handover', 'send-admission'].includes(
            command.command.operation.kind
          ) ||
            command.command.operation.kind.startsWith('queue-'))
      )
      if (controlsInput && !journalOrchestrationAttached(database) && existsSync(authorityPath)) {
        const spendsFailureRecovery = writes.some(
          ({ command }) =>
            command.type === 'write' && command.command.operation.kind === 'failure-resume'
        )
        const readOnlyAuthority = pathToFileURL(authorityPath)
        readOnlyAuthority.searchParams.set('mode', 'ro')
        database
          .prepare('ATTACH DATABASE ? AS orchestration_authority')
          .run(spendsFailureRecovery ? authorityPath : readOnlyAuthority.href)
        markJournalOrchestrationAttached(database)
      }
      const result = await batch.run<WriteRequest, CommitResponse>(
        writes,
        async (request) => {
          const { command, id } = request
          const checkpoint = forks!.checkpoint()
          try {
            if (command.type === 'maintenance') {
              return {
                type: 'maintenance',
                id,
                result:
                  command.operation.kind === 'fork-source-hold' ||
                  command.operation.kind === 'fork-source-release' ||
                  command.operation.kind === 'fork-stage-begin' ||
                  command.operation.kind === 'fork-stage-page' ||
                  command.operation.kind === 'fork-abort'
                    ? forks!.apply(command.operation, Date.now())
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
            forks!.rollback(checkpoint)
            throw error
          }
        },
        writes.some(
          (request) => request.command.type === 'write' && request.command.command.forkInstall
        )
          ? 'full'
          : 'normal'
      )
      forks!.acknowledge()
      // All acknowledged commits precede a fault notice; it never retracts a successful COMMIT.
      responses = result.outcomes.map((outcome, index) =>
        outcome.committed
          ? outcome.value
          : {
              type: 'failed',
              id: writes[index]!.id,
              outcome: 'rolled-back',
              error: journalSqlFailure(outcome.error)
            }
      )
    } catch (error) {
      forks?.rollback()
      const outcome = error instanceof JournalSqlBatchError ? error.outcome : 'not-dispatched'
      fault ??= batch.fault
      responses = writes.map((request) => ({
        type: 'failed',
        id: request.id,
        outcome,
        fatal: fault !== undefined,
        error: journalSqlFailure(error)
      }))
    }
    // Only a failure grant reserves the orchestration writer; queue reads use a read-only attachment.
    if (journalOrchestrationAttached(database)) {
      try {
        database.exec('DETACH DATABASE orchestration_authority')
        forgetJournalOrchestrationAttachment(database)
      } catch (error) {
        fault ??= error
      }
    }
    // A transfer failure after COMMIT must surface as a lost acknowledgement, never a rollback.
    for (const response of responses) {
      reply(response)
    }
  }
  if (close) {
    try {
      await (checkpointClosing ?? checkpoint?.close())
      db?.close()
      db = undefined
      reply({ type: 'done', id: close.id })
      port.close()
    } catch (error) {
      closing = false
      checkpointClosing = undefined
      reply({
        type: 'failed',
        id: close.id,
        outcome: 'not-dispatched',
        error: journalSqlFailure(error)
      })
    }
  }
  scheduleNextDrain()
}

function scheduleNextDrain(): void {
  scheduled = false
  // Requests admitted while this drain awaited its commands start the next drain.
  if (queue.length > 0 && db) {
    scheduled = true
    setImmediate(() => {
      void drain()
    })
  }
}
