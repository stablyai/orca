import { describe, expect, it, afterEach } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPinnedPreV1Backup, pinnedPreV1BackupPath } from './agent-catalog-pre-v1-backup'

const tempDirs: string[] = []

function makeDataFile(contents: string, mode?: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-agent-catalog-migration-'))
  tempDirs.push(dir)
  const dataFile = join(dir, 'orca-data.json')
  writeFileSync(dataFile, contents, mode !== undefined ? { mode } : undefined)
  return dataFile
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

describe('createPinnedPreV1Backup', () => {
  it('writes the exact raw bytes with matching permissions', () => {
    const raw = '{"settings":{"defaultTuiAgent":null}}'
    const dataFile = makeDataFile(raw, 0o600)
    const result = createPinnedPreV1Backup(dataFile, raw)
    expect(result).toEqual({ ok: true, created: true })
    const backupFile = pinnedPreV1BackupPath(dataFile)
    expect(readFileSync(backupFile, 'utf-8')).toBe(raw)
    expect(statSync(backupFile).mode & 0o777).toBe(statSync(dataFile).mode & 0o777)
  })

  it('keeps an existing pinned backup instead of overwriting it', () => {
    const original = '{"original":true}'
    const dataFile = makeDataFile(original)
    expect(createPinnedPreV1Backup(dataFile, original)).toEqual({ ok: true, created: true })
    const second = createPinnedPreV1Backup(dataFile, '{"newer":true}')
    expect(second).toEqual({ ok: true, created: false })
    expect(readFileSync(pinnedPreV1BackupPath(dataFile), 'utf-8')).toBe(original)
  })

  it('repairs a torn pinned backup that is readable but not JSON', () => {
    const raw = '{"settings":{"defaultTuiAgent":null}}'
    const dataFile = makeDataFile(raw)
    const backupFile = pinnedPreV1BackupPath(dataFile)
    writeFileSync(backupFile, '{"settings":{"defaultTui')
    expect(createPinnedPreV1Backup(dataFile, raw)).toEqual({ ok: true, created: true })
    expect(readFileSync(backupFile, 'utf-8')).toBe(raw)
  })

  it('fails rather than claim an unreadable pinned backup as a recovery point', () => {
    const raw = '{"settings":{"defaultTuiAgent":null}}'
    const dataFile = makeDataFile(raw)
    const backupFile = pinnedPreV1BackupPath(dataFile)
    mkdirSync(backupFile) // a directory at the backup path reads as EISDIR
    const result = createPinnedPreV1Backup(dataFile, raw)
    expect(result.ok).toBe(false)
    // The unknown path is left alone, and no half-written temp is stranded.
    expect(statSync(backupFile).isDirectory()).toBe(true)
    expect(existsSync(`${backupFile}.tmp`)).toBe(false)
  })

  it('fails without leaving a partial backup when the data file is unreadable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-agent-catalog-migration-'))
    tempDirs.push(dir)
    const missing = join(dir, 'missing.json')
    const result = createPinnedPreV1Backup(missing, '{}')
    expect(result.ok).toBe(false)
    expect(existsSync(pinnedPreV1BackupPath(missing))).toBe(false)
    expect(existsSync(`${pinnedPreV1BackupPath(missing)}.tmp`)).toBe(false)
  })
})
