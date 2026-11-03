import { JournalNativeReads } from './journal-sql-read'

import type { JournalEffectResult, JournalPersistenceEffect } from './journal-persistence-plan'
import {
  type JournalResultPacket,
  journalResultPackets,
  appendJournalUnitPacket
} from './journal-unit-transfer'

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'
import Database from '../../sqlite/sync-database'
import { openJournalDatabase } from './journal-database'
import { JournalCheckpointOwner } from './journal-checkpoint-owner'

import { applyJournalPersistenceEffect, applyJournalMaintenance } from './journal-persistence-unit'
import {
  journalSqlFailure,
  type JournalSqlRequest,
  type JournalSqlResponse
} from './journal-sql-protocol'

if (
  !parentPort ||
  typeof workerData !== 'object' ||
  !workerData ||
  typeof workerData.filename !== 'string'
) {
  throw new Error('journal SQL owner requires a path and parent port')
}
const port = parentPort
let db: Database.Database | undefined
let checkpoint: JournalCheckpointOwner | undefined
let closing = false
let fault: unknown
let full = true
const reader = workerData.reader === true
try {
  if (reader) {
    db = new Database(workerData.filename, { readonly: true, fileMustExist: true })
    port.postMessage({ type: 'ready', readOnly: true } satisfies JournalSqlResponse)
  } else {
    mkdirSync(dirname(workerData.filename), { recursive: true })
    const opened = openJournalDatabase(workerData.filename)
    db = opened.db
    if (!opened.readOnly) {
      checkpoint = new JournalCheckpointOwner(db, workerData.filename)
    }
    port.postMessage({ type: 'ready', readOnly: opened.readOnly } satisfies JournalSqlResponse)
  }
} catch (error) {
  fault = error
  port.postMessage({
    type: 'failed',
    outcome: 'not-dispatched',
    error: journalSqlFailure(error)
  } satisfies JournalSqlResponse)
  port.close()
}
const upload = new Map<number, JournalPersistenceEffect>()
const reads = new JournalNativeReads()
port.on('message', async ({ id, command }: JournalSqlRequest) => {
  let outcome: 'not-dispatched' | 'not-committed' | 'rolled-back' | 'indeterminate' =
    'not-dispatched'
  try {
    if (!db || closing) {
      throw new Error('journal SQL owner is unavailable')
    }
    if (command.type === 'close') {
      closing = true
      await checkpoint?.close()
      reads.close()
      upload.clear()
      if (db.isTransaction) {
        db.exec('ROLLBACK')
      }
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
    if (reader) {
      throw new Error('readonly journal owner cannot write')
    }
    if (command.type === 'discard') {
      upload.clear()
      port.postMessage({ type: 'done', id } satisfies JournalSqlResponse)
      return
    }
    if (command.type === 'upload') {
      const { index, effect } = command.packet
      const current = upload.get(index)
      if (current) {
        appendJournalUnitPacket(current, effect)
      } else {
        upload.set(index, effect)
      }
      port.postMessage({ type: 'done', id } satisfies JournalSqlResponse)
      return
    }
    if (command.type !== 'unit' && command.type !== 'maintenance') {
      throw new Error('snapshot ownership belongs to a readonly thread')
    }
    const effects =
      command.type === 'unit'
        ? Array.from({ length: command.count }, (_, index) => {
            const effect = upload.get(index)
            if (!effect) {
              throw new Error('journal upload is incomplete')
            }
            return effect
          })
        : []
    upload.clear()
    const started = performance.now()
    if (!full) {
      try {
        db.pragma('synchronous = FULL')
        full = true
      } catch (error) {
        fault = error
        throw error
      }
    }
    if (command.type === 'maintenance' || command.normal) {
      // A failed setting may have applied; prove FULL again before reusing this connection.
      full = false
      db.pragma('synchronous = NORMAL')
    }
    db.exec('BEGIN IMMEDIATE')
    outcome = 'not-committed'
    let values: JournalEffectResult[] = []
    let maintained = { more: false, valid: true }
    let resultPackets: JournalResultPacket[][] = []
    try {
      const database = db
      if (command.type === 'maintenance') {
        maintained = applyJournalMaintenance(database, command.unit)
      } else {
        values = effects.map((effect) => applyJournalPersistenceEffect(database, effect))
      }
      resultPackets = [...journalResultPackets(values)]
      outcome = 'indeterminate'
      db.exec('COMMIT')
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
    // COMMIT truth survives settings/diagnostic failure; never report this as a rollback.
    let postcommit
    try {
      checkpoint?.afterCommit()
    } catch (error) {
      postcommit = journalSqlFailure(error)
    }
    if (!full) {
      try {
        db.pragma('synchronous = FULL')
        full = true
      } catch (error) {
        postcommit ??= journalSqlFailure(error)
      }
    }
    if (command.type === 'maintenance') {
      port.postMessage({
        type: 'maintained',
        id,
        ...maintained,
        elapsed: performance.now() - started,
        ...(postcommit ? { postcommit } : {})
      } satisfies JournalSqlResponse)
    } else {
      for (const packets of resultPackets) {
        port.postMessage({ type: 'results', id, packets } satisfies JournalSqlResponse)
      }
      port.postMessage({
        type: 'committed',
        id,
        values: [],
        ...(postcommit ? { postcommit } : {})
      } satisfies JournalSqlResponse)
    }
  } catch (error) {
    if (command.type === 'close') {
      closing = false
    }
    if (!reader && db && !full && !db.isTransaction) {
      try {
        db.pragma('synchronous = FULL')
        full = true
      } catch (restore) {
        fault = restore
      }
    }
    port.postMessage({
      type: 'failed',
      id,
      outcome,
      error: journalSqlFailure(error),
      fatal: fault !== undefined
    } satisfies JournalSqlResponse)
  }
})
