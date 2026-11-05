import { sweepJournalRetiredPage } from './journal-native-retired-page'
import { openJournalDatabase } from './journal-database'
import { JournalCheckpointOwner } from './journal-checkpoint-owner'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'
import Database from '../../sqlite/sync-database'

import { AgentSessionJournalError } from './journal-write-guards'
import { JournalNativeReads } from './journal-sql-read'
import { applyJournalPersistenceEffect } from './journal-persistence-unit'
import type { JournalPersistenceEffect } from './journal-persistence-plan'
import {
  appendJournalUnitPacket,
  journalResultPackets,
  type JournalResultPacket
} from './journal-unit-transfer'
import {
  journalSqlFailure,
  type JournalSqlRequest,
  type JournalSqlResponse
} from './journal-sql-protocol'

if (!parentPort || !workerData || typeof workerData.filename !== 'string') {
  throw new Error('Journal SQL owner requires a path and parent port')
}
const port = parentPort
const reader = workerData.reader === true
const upload = new Map<number, JournalPersistenceEffect>()
const reads = new JournalNativeReads()
let db: Database.Database | undefined
let readOnly = reader
let fault: unknown
let checkpoint: JournalCheckpointOwner | undefined
try {
  if (reader) {
    db = new Database(workerData.filename, { readonly: true, fileMustExist: true })
  } else {
    mkdirSync(dirname(workerData.filename), { recursive: true })
    const opened = openJournalDatabase(workerData.filename)
    db = opened.db
    readOnly = opened.readOnly
    if (!readOnly) {
      checkpoint = new JournalCheckpointOwner(db, workerData.filename)
    }
  }
  port.postMessage({ type: 'ready', readOnly } satisfies JournalSqlResponse)
} catch (error) {
  fault = error
  port.postMessage({
    type: 'failed',
    outcome: 'not-dispatched',
    error: journalSqlFailure(error)
  } satisfies JournalSqlResponse)
  port.close()
}

port.on('message', async ({ id, command }: JournalSqlRequest) => {
  let outcome: 'not-dispatched' | 'not-committed' | 'rolled-back' | 'indeterminate' =
    'not-dispatched'
  try {
    if (!db) {
      throw new Error('Journal SQL owner is unavailable')
    }
    if (command.type === 'close') {
      reads.close()
      upload.clear()
      if (db.isTransaction) {
        db.exec('ROLLBACK')
      }
      await checkpoint?.close()
      db.close()
      db = undefined
      port.postMessage({ type: 'done', id } satisfies JournalSqlResponse)
      port.close()
      return
    }
    if (fault) {
      throw fault
    }
    if (command.type === 'read') {
      port.postMessage({
        type: 'read',
        id,
        result: reads.read(db, command.read)
      } satisfies JournalSqlResponse)
      return
    }
    if (command.type === 'snapshot' && reader) {
      if (command.open) {
        db.exec('BEGIN')
        db.prepare('SELECT rootpage FROM sqlite_master LIMIT 1').get()
      } else {
        reads.close()
        db.exec('ROLLBACK')
      }
      port.postMessage({ type: 'done', id } satisfies JournalSqlResponse)
      return
    }
    if (readOnly) {
      throw new AgentSessionJournalError('journal_read_only', 'The chat journal is read only')
    }
    if (command.type === 'discard') {
      upload.clear()
      port.postMessage({ type: 'done', id } satisfies JournalSqlResponse)
      return
    }
    if (command.type === 'upload') {
      for (const { index, effect } of command.packets) {
        const current = upload.get(index)
        if (current) {
          appendJournalUnitPacket(current, effect)
        } else {
          upload.set(index, structuredClone(effect))
        }
      }
      port.postMessage({ type: 'done', id } satisfies JournalSqlResponse)
      return
    }
    if (command.type === 'maintenance') {
      const start = performance.now()
      const unit = command.unit
      db.exec('BEGIN IMMEDIATE')
      outcome = 'not-committed'
      let result
      try {
        result = sweepJournalRetiredPage(db, unit.after)
        outcome = 'indeterminate'
        db.exec('COMMIT')
        checkpoint?.afterCommit()
      } catch (error) {
        if (db.isTransaction) {
          try {
            db.exec('ROLLBACK')
            outcome = 'rolled-back'
          } catch (rollback) {
            fault = rollback
          }
        } else if (outcome === 'not-committed') {
          outcome = 'rolled-back'
        }
        if (outcome === 'indeterminate') {
          fault = error
        }
        throw error
      }
      port.postMessage({
        type: 'maintained',
        id,
        ...result,
        more: result.more,
        elapsed: performance.now() - start
      } satisfies JournalSqlResponse)
      return
    }
    if (command.type !== 'unit') {
      throw new Error('Journal SQL owner received an unsupported command')
    }
    const effects = Array.from({ length: command.count }, (_, index) => {
      const effect = upload.get(index)
      if (!effect) {
        throw new Error('Journal upload is incomplete')
      }
      return effect
    })
    upload.clear()
    let committed = false
    let postcommit: ReturnType<typeof journalSqlFailure> | undefined
    let packets: JournalResultPacket[][]
    try {
      if (command.normal) {
        db.pragma('synchronous = NORMAL')
      }
      db.exec('BEGIN IMMEDIATE')
      outcome = 'not-committed'
      const database = db
      packets = [
        ...journalResultPackets(
          effects.map((effect) => applyJournalPersistenceEffect(database, effect))
        )
      ]
      outcome = 'indeterminate'
      db.exec('COMMIT')
      committed = true
    } catch (error) {
      if (db.isTransaction) {
        try {
          db.exec('ROLLBACK')
          outcome = 'rolled-back'
        } catch (rollback) {
          fault = rollback
        }
      } else if (outcome === 'not-committed') {
        outcome = 'rolled-back'
      }
      if (outcome === 'indeterminate') {
        fault = error
      }
      throw error
    } finally {
      if (command.normal && !db.isTransaction) {
        try {
          db.pragma('synchronous = FULL')
        } catch (error) {
          fault = error
          if (committed) {
            postcommit = journalSqlFailure(error)
          }
        }
      }
    }
    checkpoint?.afterCommit()
    for (const packet of packets) {
      port.postMessage({ type: 'results', id, packets: packet } satisfies JournalSqlResponse)
    }
    port.postMessage({ type: 'committed', id, values: [], postcommit } satisfies JournalSqlResponse)
  } catch (error) {
    port.postMessage({
      type: 'failed',
      id,
      outcome,
      error: journalSqlFailure(error),
      fatal: fault !== undefined
    } satisfies JournalSqlResponse)
  }
})
