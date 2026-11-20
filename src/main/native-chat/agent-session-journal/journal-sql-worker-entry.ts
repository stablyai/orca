import { legacyDestinationFileIdentity } from './journal-legacy-retirement-files'
import { JournalForkStages } from './journal-fork-stages'
import { JOURNAL_ASYNC_QUESTION_INDEXES } from './database/journal-async-question-index'
import { JOURNAL_ENDED_TURN_COUNTS_SCHEMA } from './database/journal-ended-turn-counts'
import { runJournalTransaction } from './database/journal-database'
import { mkdirSync, lstatSync } from 'node:fs'
import { dirname } from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'
import type Database from '../../sqlite/sync-database'
import { journalDomainDatabasePath } from './database/journal-host-database'
import {
  initializeJournalDomainDatabase,
  openJournalDomainDatabase
} from './database/journal-domain-database'
import { JournalCheckpointOwner } from './database/journal-checkpoint-owner'
import { JournalSqlBatch, JournalSqlBatchError } from './journal-sql-batch'
import { JournalSqlCommand } from './journal-sql-command'
import { applyJournalWriterEffect } from './journal-writer-effects'
import { journalSqlFailure } from './journal-sql-failure'
import type { JournalSqlRequest, JournalSqlResponse } from './journal-sql-protocol'
import { assertJournalWritable } from './writing/journal-write-guards'
import { applyJournalSqlMaintenance } from './journal-sql-maintenance'
import { tryFoldJournalTextTails } from './journal-text-tail'
import { installWorkerSendLedger } from '../../worker-threads/worker-send-ledger'
import { JournalSqlQueueClock, journalSqlTimedGate } from './journal-sql-writer-timing'
import { JournalSqlWriterQueue } from './journal-sql-writer-queue'
import { JournalSqlWalParking } from './journal-sql-wal-parking'

installWorkerSendLedger('orca-journal-sql-writer')

function legacyDestinationMain(filename: string): string {
  return legacyDestinationFileIdentity(lstatSync(filename, { bigint: true }))
}

function legacyDestinationIdentity(filename: string) {
  return { main: legacyDestinationMain(filename), wal: legacyDestinationMain(`${filename}-wal`) }
}

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
let destinationMain: string | undefined
let readOnly = true
let fault: unknown
let closing = false
let scheduled = false
const queue = new JournalSqlWriterQueue()
let parking: JournalSqlWalParking | undefined
const clock = new JournalSqlQueueClock(() => parking?.mark() ?? { bulk: 0, urgent: 0 })
const gate = { ms: 0 }

async function open(): Promise<void> {
  try {
    mkdirSync(dirname(workerData.filename), { recursive: true })
    if (workerData.filename === journalDomainDatabasePath(stateDirectory)) {
      await initializeJournalDomainDatabase(stateDirectory)
    }
    const opened = openJournalDomainDatabase(workerData.filename)
    db = opened.db
    try {
      destinationMain = legacyDestinationMain(workerData.filename)
    } catch {
      /* Cleanup eligibility never gates opening a chat. */
    }
    readOnly = opened.readOnly
    if (!readOnly) {
      db.exec(JOURNAL_ASYNC_QUESTION_INDEXES)
      runJournalTransaction(db, (writer) => writer.exec(JOURNAL_ENDED_TURN_COUNTS_SCHEMA))
    }
    forks = new JournalForkStages(db, stateDirectory)
    commands = new JournalSqlCommand(db, stateDirectory, forks)
    if (!readOnly) {
      checkpoint = new JournalCheckpointOwner(db, workerData.filename)
      parking = new JournalSqlWalParking(checkpoint)
    }
    batch = new JournalSqlBatch(db, checkpoint && journalSqlTimedGate(checkpoint, gate))
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
  if (request.command.type === 'promote') {
    if (queue.promote(request.command.sessionId)) {
      parking?.interrupt()
    }
    return
  }
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
  clock.receive(request.id)
  if (queue.push(request)) {
    parking?.interrupt()
  }
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
  urgent?: true
  command: Exclude<JournalSqlRequest['command'], { type: 'close' } | { type: 'promote' }>
}
type CommitResponse = Extract<JournalSqlResponse, { type: 'committed' | 'effects' | 'maintenance' }>
type TimedResponse = CommitResponse | Extract<JournalSqlResponse, { type: 'failed' }>
/** Bound ready work before opening a transaction, then yield after its acknowledgements. */
async function drain(): Promise<void> {
  const head = queue.peek()
  if (head && head.command.type !== 'close' && parking && !checkpoint!.admits(!!head.urgent)) {
    // Waiting for WAL room must not hold the writer while a send's urgent write queues behind it.
    await parking.park(!!head.urgent)
    scheduleNextDrain()
    return
  }
  const depth = queue.size
  const startedAt = performance.now()
  const pending = queue.take()
  const urgent = pending.every((request) => request.urgent)
  const writes = pending.filter(
    (request): request is WriteRequest =>
      request.command.type !== 'close' && request.command.type !== 'promote'
  )
  const close = pending.find((request) => request.command.type === 'close')
  const database = db
  if (writes.length > 0 && database && batch && commands) {
    const executor = commands
    let responses: TimedResponse[] = []
    try {
      if (fault) {
        throw fault
      }
      assertJournalWritable(readOnly, 'database')
      const result = await batch.run<WriteRequest, CommitResponse>(
        writes,
        async (request) => {
          const { command, id } = request
          const checkpoint = forks!.checkpoint()
          try {
            if (command.type === 'maintenance') {
              if (command.operation.kind === 'legacy-retirement-save') {
                if (
                  destinationMain !== legacyDestinationMain(workerData.filename) ||
                  (command.operation.destination &&
                    JSON.stringify(command.operation.destination) !==
                      JSON.stringify(legacyDestinationIdentity(workerData.filename)))
                ) {
                  throw new Error('journal destination generation changed')
                }
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
          (request) =>
            request.command.type === 'maintenance' &&
            request.command.operation.kind === 'legacy-retirement-save' &&
            request.command.operation.durable
        )
          ? 'retirement'
          : writes.some(
                (request) => request.command.type === 'write' && request.command.command.forkInstall
              )
            ? 'full'
            : 'normal',
        urgent
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
    const runMs = performance.now() - startedAt - gate.ms
    const walFrames = checkpoint?.log ?? 0
    // A transfer failure after COMMIT must surface as a lost acknowledgement, never a rollback.
    for (const [index, response] of responses.entries()) {
      const request = writes[index]!
      reply({
        ...response,
        timing: {
          depth,
          ...clock.timing(request, startedAt, gate.ms),
          runMs,
          batch: writes.length,
          walFrames
        }
      })
    }
    gate.ms = 0
  }
  for (const request of pending) {
    clock.forget(request.id)
  }
  if (close) {
    try {
      if (!readOnly && db) {
        tryFoldJournalTextTails(db)
      }
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
  if (queue.size > 0 && db) {
    scheduled = true
    setImmediate(() => {
      void drain()
    })
  }
}
