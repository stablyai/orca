#!/usr/bin/env bun

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import SyncDatabase from '../../src/main/sqlite/sync-database.ts'
import {
  beginLifecycleWriteTransaction,
  commitLifecycleWriteTransaction,
  rollbackLifecycleWriteTransaction
} from '../../src/main/runtime/orchestration/db/lifecycle-transition.ts'
const artifactDir = process.env.ORCAD_NATIVE_ARTIFACT_DIR
const packageRoot = artifactDir ? realpathSync(resolve(artifactDir)) : null
const loadPackage = createRequire(packageRoot ? join(packageRoot, 'orcad.js') : import.meta.url)
const requiredPackages = ['@parcel/watcher']
const loaded = requiredPackages.map((name) => {
  if (packageRoot) {
    const resolved = relative(packageRoot, realpathSync(loadPackage.resolve(name)))
    if (resolved.startsWith('..') || isAbsolute(resolved)) {
      throw new Error(`${name} resolved outside the supplied artifact`)
    }
  }
  const module = loadPackage(name)
  return { name, loaded: typeof module === 'object' || typeof module === 'function' }
})
const watcher = loadPackage('@parcel/watcher')

const root = mkdtempSync(join(tmpdir(), 'orca-bun-native-smoke-'))
const database = new SyncDatabase(join(root, 'state.db'), { timeout: 250 })
database.exec('CREATE TABLE proof (value TEXT)')
database.prepare('INSERT INTO proof (value) VALUES (?)').run('bun-sqlite-ok')
const sqliteValue = database.prepare('SELECT value FROM proof').get()?.value
const transactionStates = [database.isTransaction]
database.exec('BEGIN IMMEDIATE')
transactionStates.push(database.isTransaction)
database.exec('ROLLBACK')
transactionStates.push(database.isTransaction)
database.exec('BEGIN IMMEDIATE')
transactionStates.push(database.isTransaction)
database.exec('COMMIT')
transactionStates.push(database.isTransaction)
const transactionStateValid =
  JSON.stringify(transactionStates) === JSON.stringify([false, true, false, true, false])
database.exec('BEGIN IMMEDIATE')
const nestedCommit = beginLifecycleWriteTransaction(database, 'smoke_nested_commit')
database.prepare('INSERT INTO proof (value) VALUES (?)').run('nested-commit')
commitLifecycleWriteTransaction(database, nestedCommit)
const callerStillActive = database.isTransaction
database.exec('ROLLBACK')
database.exec('BEGIN IMMEDIATE')
database.prepare('INSERT INTO proof (value) VALUES (?)').run('outer-commit')
const nestedRollback = beginLifecycleWriteTransaction(database, 'smoke_nested_rollback')
database.prepare('INSERT INTO proof (value) VALUES (?)').run('nested-rollback')
rollbackLifecycleWriteTransaction(database, nestedRollback)
const callerSurvivedRollback = database.isTransaction
database.exec('COMMIT')
const lifecycleTransactionsValid =
  callerStillActive &&
  callerSurvivedRollback &&
  JSON.stringify(database.prepare('SELECT value FROM proof ORDER BY value').all()) ===
    JSON.stringify([{ value: 'bun-sqlite-ok' }, { value: 'outer-commit' }])
database.close()

let eventCount = 0
const subscription = await watcher.subscribe(root, (_error, events) => {
  eventCount += events.length
})
writeFileSync(join(root, 'watch-marker'), 'ok')
const deadline = Date.now() + 5_000
while (eventCount === 0 && Date.now() < deadline) {
  await Bun.sleep(25)
}
await subscription.unsubscribe()
rmSync(root, { recursive: true, force: true })

const result = {
  ok:
    loaded.every((entry) => entry.loaded) &&
    sqliteValue === 'bun-sqlite-ok' &&
    transactionStateValid &&
    lifecycleTransactionsValid &&
    eventCount > 0,
  runtime: `bun ${Bun.version}`,
  platform: `${process.platform}-${process.arch}`,
  loaded,
  sqliteValue,
  transactionStates,
  lifecycleTransactionsValid,
  watcherEvents: eventCount
}
console.log(JSON.stringify(result))
if (!result.ok) {
  process.exit(1)
}
