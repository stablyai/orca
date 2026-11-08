import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'
import type Database from '../../sqlite/sync-database'
import { openJournalDatabase } from './database/journal-database'
import { JournalCheckpointOwner } from './database/journal-checkpoint-owner'
import { JournalSqlBatch, JournalSqlBatchError } from './journal-sql-batch'
import { JournalSqlCommand } from './journal-sql-command'
import { takeJournalSqlReadyBatch } from './journal-sql-ready-batch'
import { applyJournalWriterEffect } from './journal-writer-effects'
import { journalSqlFailure, type JournalSqlFailure } from './journal-sql-failure'
import type { JournalSqlRequest, JournalSqlResponse } from './journal-sql-protocol'
import { assertJournalWritable } from './writing/journal-write-guards'
import { applyJournalSqlMaintenance } from './journal-sql-maintenance'
import { initializeJournalSqlProjection } from './journal-sql-schema-migration'
import { migrateJournalDomainSchema } from './journal-domain-schema'
import { commitJournalSqlMessages } from './journal-sql-message-commit'

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
let checkpoint: JournalCheckpointOwner | undefined
let readOnly = true
let fault: unknown
let closing = false
let scheduled = false
const queue: JournalSqlRequest[] = []

try {
  mkdirSync(dirname(workerData.filename), { recursive: true })
  const opened = openJournalDatabase(workerData.filename)
  db = opened.db
  readOnly = opened.readOnly
  batch = new JournalSqlBatch(db)
  commands = new JournalSqlCommand(db, stateDirectory)
  if (!readOnly) {
    initializeJournalSqlProjection(db)
    migrateJournalDomainSchema(db)
    checkpoint = new JournalCheckpointOwner(db, workerData.filename)
  }
  reply({ type: 'ready', readOnly })
} catch (error) {
  fault = error
  reply({ type: 'failed', outcome: 'not-dispatched', fatal: true, error: journalSqlFailure(error) })
  db?.close()
  port.close()
}

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
  command: Exclude<JournalSqlRequest['command'], { type: 'close' | 'messages' }>
}
type CommitResponse = Extract<JournalSqlResponse, { type: 'committed' | 'effects' | 'maintenance' }>

/** Bound ready work before opening a transaction, then yield after its acknowledgements. */
async function drain(): Promise<void> {
  if (queue[0]?.command.type === 'messages') {
    await drainMessages(queue.shift()!)
    scheduleNextDrain()
    return
  }
  const pending = takeJournalSqlReadyBatch(queue, (command) => commands?.streamed(command) === true)
  const writes = pending.filter(
    (entry): entry is { request: WriteRequest; normal: boolean } =>
      entry.request.command.type !== 'close' && entry.request.command.type !== 'messages'
  )
  const close = pending.find(({ request }) => request.command.type === 'close')?.request
  const database = db
  if (writes.length > 0 && database && batch && commands) {
    const executor = commands
    let responses: JournalSqlResponse[] = []
    let postcommit: JournalSqlFailure | undefined
    try {
      if (fault) {
        throw fault
      }
      assertJournalWritable(readOnly, 'database')
      const result = await batch.run<WriteRequest, CommitResponse>(
        writes.map(({ request, normal }) => ({
          command: request,
          normal
        })),
        async (request) => {
          const { command, id } = request
          if (command.type === 'maintenance') {
            return {
              type: 'maintenance',
              id,
              result: applyJournalSqlMaintenance(database, command.operation)
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
        }
      )
      postcommit = result.postcommit ? journalSqlFailure(result.postcommit) : undefined
      try {
        checkpoint?.afterCommit()
      } catch (error) {
        postcommit ??= journalSqlFailure(error)
      }
      // All acknowledged commits precede a fault notice; it never retracts a successful COMMIT.
      responses = result.outcomes.map((outcome, index) =>
        outcome.committed
          ? outcome.value
          : {
              type: 'failed',
              id: writes[index]!.request.id,
              outcome: 'rolled-back',
              error: journalSqlFailure(outcome.error)
            }
      )
      if (postcommit) {
        fault = result.postcommit ?? postcommit
      }
    } catch (error) {
      const outcome = error instanceof JournalSqlBatchError ? error.outcome : 'not-dispatched'
      fault ??= batch.fault
      responses = writes.map(({ request }) => ({
        type: 'failed',
        id: request.id,
        outcome,
        fatal: fault !== undefined,
        error: journalSqlFailure(error)
      }))
    }
    // A transfer failure after COMMIT must surface as a lost acknowledgement, never a rollback.
    for (const response of responses) {
      reply(response)
    }
    if (postcommit) {
      reply({ type: 'failed', outcome: 'not-dispatched', fatal: true, error: postcommit })
    }
  }
  if (close) {
    try {
      await checkpoint?.close()
      db?.close()
      db = undefined
      reply({ type: 'done', id: close.id })
      port.close()
    } catch (error) {
      closing = false
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

async function drainMessages(request: JournalSqlRequest): Promise<void> {
  if (request.command.type !== 'messages' || !db || !batch) {
    throw new Error('journal message drain has no writer')
  }
  try {
    if (fault) {
      throw fault
    }
    assertJournalWritable(readOnly, request.command.job.command.target.sessionId)
    const result = await commitJournalSqlMessages(db, batch, [request.command.job], (commit) => {
      reply({ type: 'messages', id: request.id, commit })
    })
    const outcome = result.outcomes[0]
    if (outcome && !outcome.committed) {
      reply({
        type: 'failed',
        id: request.id,
        outcome: 'rolled-back',
        error: journalSqlFailure(outcome.error)
      })
    }
    let postcommit = result.postcommit
    try {
      checkpoint?.afterCommit()
    } catch (error) {
      postcommit ??= error
    }
    if (postcommit) {
      fault = postcommit
      reply({
        type: 'failed',
        outcome: 'not-dispatched',
        fatal: true,
        error: journalSqlFailure(postcommit)
      })
    }
  } catch (error) {
    fault ??= batch.fault
    reply({
      type: 'failed',
      id: request.id,
      outcome: error instanceof JournalSqlBatchError ? error.outcome : 'indeterminate',
      fatal: fault !== undefined,
      error: journalSqlFailure(error)
    })
  }
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
