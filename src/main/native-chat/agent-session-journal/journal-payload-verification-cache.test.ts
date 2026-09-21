// Why its own file: the sha256 counter below needs `node:crypto` mocked for the
// whole module graph, which would change what every other store test measures.

import { createHash, type Hash } from 'node:crypto'
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JournalPayloadStore } from './journal-payload-store'

const hashes = vi.hoisted(() => ({ count: 0 }))

type HashingModule = Record<string, unknown> & { createHash(algorithm: string): Hash }

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<HashingModule>()
  return {
    ...actual,
    default: actual,
    createHash: (algorithm: string) => {
      hashes.count += 1
      return actual.createHash(algorithm)
    }
  }
})

let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-payload-verify-'))
  hashes.count = 0
})
afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

function retain(store: JournalPayloadStore, payload: string): string {
  const digest = createHash('sha256').update(payload, 'utf8').digest('hex')
  expect(store.retain(digest, payload)).toBe(true)
  return digest
}

describe('retrieveRange verifies a payload once per file identity', () => {
  it('hashes once across a two-page read', () => {
    const store = new JournalPayloadStore({ directory })
    const payload = 'p'.repeat(40_000)
    const digest = retain(store, payload)

    hashes.count = 0
    const first = store.retrieveRange(digest, 0, 20_000)
    expect(first?.complete).toBe(false)
    expect(hashes.count).toBe(1)

    const second = store.retrieveRange(digest, first!.chunkOffset + first!.chunkByteLength, 20_000)
    expect(second?.complete).toBe(true)
    // The second page serves from the already-verified file: no re-hash.
    expect(hashes.count).toBe(1)
    expect(`${first!.chunk}${second!.chunk}`).toBe(payload)
  })

  it('re-verifies, and refuses, once the retained file changes underneath it', () => {
    const store = new JournalPayloadStore({ directory })
    const payload = 'q'.repeat(40_000)
    const digest = retain(store, payload)
    const path = join(directory, `${digest}.payload`)
    expect(store.retrieveRange(digest, 0, 20_000)?.chunkByteLength).toBe(20_000)

    // Same byte length, different content: only the timestamp says so.
    writeFileSync(path, 'r'.repeat(40_000))
    const changed = statSync(path)
    expect(changed.size).toBe(40_000)
    utimesSync(path, changed.atime, new Date(changed.mtimeMs + 5_000))
    expect(() => store.retrieveRange(digest, 20_000, 20_000)).toThrow(
      expect.objectContaining({ name: 'JournalPayloadIntegrityError' })
    )
  })
})
