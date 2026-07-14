import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { blobPath, putBlob, readBlob } from './chat-import-blobstore'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'blobs-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('putBlob/readBlob', () => {
  it('stores content-addressed and reads back; dedups identical bytes', () => {
    const bytes = Buffer.from('hello attachment')
    const hash = putBlob(dir, bytes)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(existsSync(join(dir, hash.slice(0, 2), hash))).toBe(true)
    expect(readBlob(dir, hash)?.equals(bytes)).toBe(true)
    expect(putBlob(dir, bytes)).toBe(hash) // dedup, same hash
  })
})
describe('blobPath', () => {
  it('rejects non-64-hex (traversal guard)', () => {
    expect(blobPath(dir, '../etc/passwd')).toBeNull()
    expect(blobPath(dir, 'a'.repeat(63))).toBeNull()
    expect(blobPath(dir, 'a'.repeat(64))).toBe(join(dir, 'aa', 'a'.repeat(64)))
  })
})
