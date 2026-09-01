#!/usr/bin/env bun

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import watcher from '@parcel/watcher'
import SyncDatabase from '../../src/main/sqlite/sync-database.ts'
const requiredPackages = [
  '@parcel/watcher',
  'node-pty',
  'sherpa-onnx',
  '@vscode/windows-process-tree'
]
const optionalPackages = ['cpu-features', ...(process.platform === 'darwin' ? ['fsevents'] : [])]
const loaded = requiredPackages.map((name) => {
  const module = require(name)
  return { name, loaded: typeof module === 'object' || typeof module === 'function' }
})
const optionalFailures = optionalPackages.flatMap((name) => {
  try {
    require(name)
    return []
  } catch (error) {
    return [{ name, error: String(error) }]
  }
})

const root = mkdtempSync(join(tmpdir(), 'orca-bun-native-smoke-'))
const database = new SyncDatabase(join(root, 'state.db'), { timeout: 250 })
database.exec('CREATE TABLE proof (value TEXT)')
database.prepare('INSERT INTO proof (value) VALUES (?)').run('bun-sqlite-ok')
const sqliteValue = database.prepare('SELECT value FROM proof').get()?.value
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
  ok: loaded.every((entry) => entry.loaded) && sqliteValue === 'bun-sqlite-ok' && eventCount > 0,
  runtime: `bun ${Bun.version}`,
  platform: `${process.platform}-${process.arch}`,
  loaded,
  optionalFailures,
  sqliteValue,
  watcherEvents: eventCount
}
console.log(JSON.stringify(result))
if (!result.ok) {
  process.exit(1)
}
