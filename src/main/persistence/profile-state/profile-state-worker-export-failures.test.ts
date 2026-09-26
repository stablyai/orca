import { build } from 'esbuild'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { openProfileStateDatabase } from './profile-state-database'
import {
  hashProfileStateJson,
  importProfileStateJson,
  readProfileStateJsonAcceptance
} from './profile-state-documents'
import { ProfileStateSqliteAuthority } from './profile-state-sqlite-authority'
import { ProfileStateWriteWorkerClient } from './profile-state-writer-worker-client'

let bundleRoot: string
let workerPath: string
const fixtures: { root: string; client: ProfileStateWriteWorkerClient }[] = []
beforeAll(async () => {
  bundleRoot = mkdtempSync(join(tmpdir(), 'orca-export-worker-bundle-'))
  workerPath = join(bundleRoot, 'writer.cjs')
  await build({
    entryPoints: [
      resolve('src/main/persistence/profile-state/profile-state-writer-worker-entry.ts')
    ],
    outfile: workerPath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent'
  })
})
afterEach(async () => {
  for (const { root, client } of fixtures.splice(0)) {
    await client.close().catch(() => {})
    rmSync(root, { recursive: true, force: true })
  }
})
afterAll(() => rmSync(bundleRoot, { recursive: true, force: true }))

async function fixture(fault: 'rename' | 'exit' | 'read-rollback') {
  const root = mkdtempSync(join(tmpdir(), 'orca-export-worker-'))
  const databasePath = join(root, 'profile-state.db')
  const dataFile = join(root, 'orca-data.json')
  const exportFile = join(root, 'explicit-export.json')
  const profileId = 'export-failure'
  const original = '{"settings":{"theme":"light"}}'
  writeFileSync(dataFile, original)
  const withDatabase = <T>(
    run: (db: ReturnType<typeof openProfileStateDatabase>['db']) => T
  ): T => {
    const { db } = openProfileStateDatabase(databasePath, profileId)
    try {
      return run(db)
    } finally {
      db.close()
    }
  }
  withDatabase((db) =>
    importProfileStateJson(db, original, {
      acceptedLegacyJsonHash: hashProfileStateJson(original)
    })
  )
  const bootstrap = new ProfileStateSqliteAuthority(databasePath, profileId)
  bootstrap.readSerializedState()
  bootstrap.writeSerializedDomains([{ domain: 'settings', payload: '{"theme":"dark"}' }])
  const wrapper = join(root, 'fault-worker.cjs')
  const faultSource =
    fault === 'read-rollback'
      ? `
      const DatabaseSync = process.versions.bun
        ? require('bun:sqlite').Database
        : require('node:sqlite').DatabaseSync
      const { existsSync } = require('node:fs')
      const exec = DatabaseSync.prototype.exec
      DatabaseSync.prototype.exec = function(sql) {
        if (existsSync(${JSON.stringify(join(root, 'armed'))}) &&
            (sql === 'COMMIT' || sql === 'ROLLBACK')) {
          throw new Error('injected read transaction release failure')
        }
        return exec.call(this, sql)
      }
    `
      : `
      const fs = require('node:fs')
      const rename = fs.renameSync
      let injected = false
      fs.renameSync = function(source, target) {
        if (!injected && target === ${JSON.stringify(exportFile)}) {
          injected = true
          if (${JSON.stringify(fault)} === 'exit') {
            rename(source, target)
            process.exit(19)
          }
          throw Object.assign(new Error('injected publication failure'), { code: 'ENOSPC' })
        }
        return rename(source, target)
      }
    `
  writeFileSync(wrapper, `${faultSource}\nrequire(${JSON.stringify(workerPath)})`)
  const onFailure = vi.fn()
  const client = new ProfileStateWriteWorkerClient(bootstrap.retireForWorker(), {
    workerPath: wrapper,
    onFailure
  })
  fixtures.push({ root, client })
  await client.ready
  writeFileSync(join(root, 'armed'), '')
  const readAccepted = () => {
    const reader = new ProfileStateSqliteAuthority(databasePath, profileId)
    try {
      return reader.readAcceptedState(readFileSync(dataFile, 'utf8'))?.takeParsedState?.()
    } finally {
      reader.close()
    }
  }
  return { client, dataFile, exportFile, original, withDatabase, readAccepted, onFailure }
}

it('keeps the real worker usable after a known explicit export publication failure', async () => {
  const f = await fixture('rename')
  await expect(f.client.writeJsonExport(f.exportFile)).rejects.toMatchObject({
    outcome: 'known-failure'
  })
  expect(readFileSync(f.dataFile, 'utf8')).toBe(f.original)
  expect(f.readAccepted()).toEqual({ settings: { theme: 'dark' } })
  expect(f.onFailure).not.toHaveBeenCalled()
  expect(await f.client.assertCurrentRevision()).toBe(2)
  await f.client.writeSerializedDomains([{ domain: 'settings', payload: '{"theme":"system"}' }])
  await f.client.writeJsonExport(f.exportFile)
  expect(JSON.parse(readFileSync(f.exportFile, 'utf8'))).toEqual({ settings: { theme: 'system' } })
  expect(readFileSync(f.dataFile, 'utf8')).toBe(f.original)
  expect(f.withDatabase(readProfileStateJsonAcceptance)).toEqual({
    jsonHash: hashProfileStateJson(f.original),
    acceptedRevision: 1
  })
})

it.each(['exit', 'read-rollback'] as const)(
  'keeps an unacknowledged export %s fenced even when its files remain recoverable',
  async (fault) => {
    const f = await fixture(fault)
    const failure = await f.client.writeJsonExport(f.exportFile).catch((error: unknown) => error)
    expect(failure).toMatchObject({ outcome: 'indeterminate' })
    await expect(
      f.client.writeSerializedDomains([{ domain: 'settings', payload: '{}' }])
    ).rejects.toBe(failure)
    await f.client.close()
    expect(f.onFailure).toHaveBeenCalledExactlyOnceWith(failure)
    expect(f.readAccepted()).toEqual({ settings: { theme: 'dark' } })
    expect(readFileSync(f.dataFile, 'utf8')).toBe(f.original)
    if (fault === 'exit') {
      expect(JSON.parse(readFileSync(f.exportFile, 'utf8')).settings.theme).toBe('dark')
    }
  }
)
