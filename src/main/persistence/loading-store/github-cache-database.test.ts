import {
  existsSync,
  mkdtempSync,
  openSync,
  closeSync,
  rmSync,
  writeSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import SyncDatabase from '../../sqlite/sync-database'
import { getGithubCacheDatabaseFile, writeGitHubCacheDatabase } from './github-cache-database'
import { readGitHubCacheDatabase } from './github-cache-startup-read'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function profileDataFile(): string {
  const directory = mkdtempSync(join(tmpdir(), 'orca-github-cache-'))
  directories.push(directory)
  return join(directory, 'orca-data.json')
}

const pr = (fetchedAt: number) => ({ data: null, fetchedAt })
const sidecarPath = (dataFile: string) => join(dataFile, '..', 'orca-github-cache.json')
const save = (dataFile: string, cache: Parameters<typeof writeGitHubCacheDatabase>[1]): void => {
  void writeGitHubCacheDatabase(dataFile, cache, { busyTimeoutMs: 0, importedLegacyFileHash: null })
}

describe('github cache database', () => {
  it('keeps an older build sidecar until its imported rows commit', async () => {
    const dataFile = profileDataFile()
    save(dataFile, { pr: { 'o/r#1': pr(1) }, issue: {} })
    writeFileSync(sidecarPath(dataFile), JSON.stringify({ pr: { 'o/r#5': pr(5) }, issue: {} }))
    const legacy = readGitHubCacheDatabase(dataFile)
    expect(legacy.cache).toEqual({ pr: { 'o/r#5': pr(5) }, issue: {} })

    const locker = new SyncDatabase(getGithubCacheDatabaseFile(dataFile))
    locker.exec('BEGIN IMMEDIATE')
    const options = { busyTimeoutMs: 0, importedLegacyFileHash: legacy.sidecarHash }
    expect(() => writeGitHubCacheDatabase(dataFile, legacy.cache!, options)).toThrow(/locked/)
    expect(existsSync(sidecarPath(dataFile))).toBe(true)
    locker.exec('ROLLBACK')
    locker.close()

    await writeGitHubCacheDatabase(dataFile, legacy.cache!, options)
    expect(existsSync(sidecarPath(dataFile))).toBe(false)
    expect(readGitHubCacheDatabase(dataFile)).toEqual({
      cache: { pr: { 'o/r#5': pr(5) }, issue: {} },
      fromSidecar: false,
      sidecarHash: null
    })
  })

  it('never lets an already imported sidecar shadow later saves, even while locked', async () => {
    const dataFile = profileDataFile()
    const sidecar = JSON.stringify({ pr: { 'o/r#5': pr(5) }, issue: {} })
    writeFileSync(sidecarPath(dataFile), sidecar)
    const legacy = readGitHubCacheDatabase(dataFile)
    await writeGitHubCacheDatabase(dataFile, legacy.cache!, {
      busyTimeoutMs: 0,
      importedLegacyFileHash: legacy.sidecarHash
    })
    // The same imported file survives, as when its deletion failed.
    writeFileSync(sidecarPath(dataFile), sidecar)
    save(dataFile, { pr: { 'o/r#6': pr(6) }, issue: {} })
    const locker = new SyncDatabase(getGithubCacheDatabaseFile(dataFile))
    locker.exec('BEGIN IMMEDIATE')
    try {
      expect(readGitHubCacheDatabase(dataFile).cache).toEqual({ pr: { 'o/r#6': pr(6) }, issue: {} })
    } finally {
      locker.exec('ROLLBACK')
      locker.close()
    }
  })

  it('rebuilds a database whose entry rows are corrupt and saves again', () => {
    const dataFile = profileDataFile()
    save(dataFile, { pr: { 'o/r#1': pr(1) }, issue: {} })
    const path = getGithubCacheDatabaseFile(dataFile)
    const db = new SyncDatabase(path)
    const root = db.prepare(`SELECT rootpage FROM sqlite_master WHERE name = 'entries'`).get()
    const pageSize = db.pragma('page_size', { simple: true })
    db.close()
    const fd = openSync(path, 'r+')
    writeSync(
      fd,
      Buffer.from([0xff, 0xff, 0xff, 0xff]),
      0,
      4,
      (Number(root?.rootpage) - 1) * Number(pageSize)
    )
    closeSync(fd)

    save(dataFile, { pr: { 'o/r#2': pr(2) }, issue: {} })
    expect(readGitHubCacheDatabase(dataFile).cache).toEqual({ pr: { 'o/r#2': pr(2) }, issue: {} })
  })
})
