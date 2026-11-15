import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import SyncDatabase from '../../../sqlite/sync-database'
import {
  getGithubCacheDatabaseFile,
  readGitHubCacheDatabase,
  writeGitHubCacheDatabase
} from './github-cache-database'

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
      sidecarHash: null,
      unavailable: false
    })
  })
})
