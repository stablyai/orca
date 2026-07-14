import { mkdirSync, mkdtempSync, rmSync, existsSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  collectBlobGarbage,
  cleanTempAttachments,
  runChatImportStorageGc
} from './chat-import-storage-gc'

let dirs: string[] = []
afterEach(() => {
  for (const d of dirs) {
    rmSync(d, { recursive: true, force: true })
  }
  dirs = []
})
function tempRoot(): string {
  const d = mkdtempSync(join(tmpdir(), 'orca-gc-'))
  dirs.push(d)
  return d
}
// 64-hex blob 이름을 만든다(내용은 무관, GC는 파일명·mtime만 본다).
function hex(seed: string): string {
  return (seed + '0'.repeat(64)).slice(0, 64).replace(/[^0-9a-f]/g, '0')
}
function writeBlob(blobDir: string, hash: string, mtimeMs: number): void {
  const dir = join(blobDir, hash.slice(0, 2))
  mkdirSync(dir, { recursive: true })
  const p = join(dir, hash)
  writeFileSync(p, 'x')
  utimesSync(p, new Date(mtimeMs), new Date(mtimeMs))
}
function writeTmp(blobDir: string, sub: string, name: string, mtimeMs: number): string {
  const dir = join(blobDir, sub)
  mkdirSync(dir, { recursive: true })
  const p = join(dir, name)
  writeFileSync(p, 'x')
  utimesSync(p, new Date(mtimeMs), new Date(mtimeMs))
  return p
}

const NOW = 1_000_000_000_000
const HOUR = 60 * 60 * 1000

describe('collectBlobGarbage', () => {
  it('deletes old orphan blobs but keeps referenced and recent ones', () => {
    const blobDir = tempRoot()
    const referenced = hex('aa')
    const orphanOld = hex('bb')
    const orphanRecent = hex('cc')
    writeBlob(blobDir, referenced, NOW - 2 * HOUR) // referenced → keep
    writeBlob(blobDir, orphanOld, NOW - 2 * HOUR) // orphan + old → delete
    writeBlob(blobDir, orphanRecent, NOW - 1000) // orphan but recent → keep (in-flight guard)

    const result = collectBlobGarbage({
      blobDir,
      referencedHashes: new Set([referenced]),
      now: NOW,
      graceMs: HOUR
    })

    expect(result.orphanBlobs).toBe(1)
    expect(existsSync(join(blobDir, referenced.slice(0, 2), referenced))).toBe(true)
    expect(existsSync(join(blobDir, orphanRecent.slice(0, 2), orphanRecent))).toBe(true)
    expect(existsSync(join(blobDir, orphanOld.slice(0, 2), orphanOld))).toBe(false)
  })

  it('deletes stale .tmp files but keeps recent ones', () => {
    const blobDir = tempRoot()
    const staleTmp = writeTmp(blobDir, 'ab', '.old.tmp', NOW - 2 * HOUR)
    const recentTmp = writeTmp(blobDir, 'ab', '.new.tmp', NOW - 1000)

    const result = collectBlobGarbage({
      blobDir,
      referencedHashes: new Set(),
      now: NOW,
      graceMs: HOUR
    })

    expect(result.staleTmp).toBe(1)
    expect(existsSync(staleTmp)).toBe(false)
    expect(existsSync(recentTmp)).toBe(true)
  })

  it('returns zeros for a missing blob dir', () => {
    const result = collectBlobGarbage({
      blobDir: join(tempRoot(), 'does-not-exist'),
      referencedHashes: new Set(),
      now: NOW,
      graceMs: HOUR
    })
    expect(result).toEqual({ orphanBlobs: 0, staleTmp: 0 })
  })
})

describe('cleanTempAttachments', () => {
  it('deletes temp files older than maxAge, keeps recent ones', () => {
    const tmpDir = tempRoot()
    const old = join(tmpDir, 'old.png')
    const recent = join(tmpDir, 'recent.png')
    writeFileSync(old, 'x')
    utimesSync(old, new Date(NOW - 2 * HOUR), new Date(NOW - 2 * HOUR))
    writeFileSync(recent, 'x')
    utimesSync(recent, new Date(NOW - 1000), new Date(NOW - 1000))

    const result = cleanTempAttachments({ tmpDir, now: NOW, maxAgeMs: HOUR })

    expect(result.removed).toBe(1)
    expect(existsSync(old)).toBe(false)
    expect(existsSync(recent)).toBe(true)
  })

  it('returns zero for a missing temp dir', () => {
    const result = cleanTempAttachments({
      tmpDir: join(tempRoot(), 'nope'),
      now: NOW,
      maxAgeMs: HOUR
    })
    expect(result.removed).toBe(0)
  })
})

describe('runChatImportStorageGc', () => {
  it('skips blob GC when the DB is missing (never wipes on an unknown ref set) but still cleans temp', () => {
    const root = tempRoot()
    const blobDir = join(root, 'blobs')
    const orphan = hex('dd')
    writeBlob(blobDir, orphan, NOW - 2 * HOUR) // old + orphan → would delete IF GC ran

    const tmpDir = join(root, 'tmp')
    mkdirSync(tmpDir, { recursive: true })
    const oldTemp = join(tmpDir, 'old.png')
    writeFileSync(oldTemp, 'x')
    utimesSync(oldTemp, new Date(NOW - 2 * HOUR), new Date(NOW - 2 * HOUR))

    const result = runChatImportStorageGc({
      dbPath: join(root, 'missing.db'),
      blobDir,
      tempAttachmentsDir: tmpDir,
      now: NOW,
      blobGraceMs: HOUR,
      tempMaxAgeMs: HOUR
    })

    // DB missing → the orphan blob MUST survive (no reference set means "unknown",
    // not "everything is garbage").
    expect(result.orphanBlobs).toBe(0)
    expect(existsSync(join(blobDir, orphan.slice(0, 2), orphan))).toBe(true)
    // Temp cleanup is independent of the DB and still runs.
    expect(result.tempRemoved).toBe(1)
    expect(existsSync(oldTemp)).toBe(false)
  })
})
