import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'
import type Database from '../../sqlite/sync-database'
import { openJournalDatabase } from './journal-database'
import { JournalCheckpointOwner } from './journal-checkpoint-owner'
import { JournalSqlBatch, JournalSqlBatchError } from './journal-sql-batch'
import { JournalSqlCommand } from './journal-sql-command'
import { applyJournalWriterEffect } from './journal-writer-effects'
import { journalSqlFailure, type JournalSqlFailure } from './journal-sql-failure'
import type { JournalSqlRequest, JournalSqlResponse } from './journal-sql-protocol'
import { assertJournalWritable } from './journal-write-guards'

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
  command: Exclude<JournalSqlRequest['command'], { type: 'close' }>
}
type CommitResponse = Extract<JournalSqlResponse, { type: 'committed' | 'effects' }>

/** Capture once, then yield: a continuing stream cannot extend this transaction past its drain. */
async function drain(): Promise<void> {
  const pending = queue.splice(0)
  const writes = pending.filter(
    (request): request is WriteRequest => request.command.type !== 'close'
  )
  const close = pending.find((request) => request.command.type === 'close')
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
      const result = batch.run<WriteRequest, CommitResponse>(
        writes.map((request) => ({
          command: request,
          normal: request.command.type === 'write' && executor.streamed(request.command.command)
        })),
        (request) => {
          const { command, id } = request
          return command.type === 'write'
            ? { type: 'committed', id, commit: executor.apply(command.command, Date.now()) }
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
              id: writes[index]!.id,
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
      responses = writes.map((request) => ({
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
  scheduled = false
}
