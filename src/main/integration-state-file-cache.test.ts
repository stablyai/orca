import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createIntegrationStateFileCache } from './integration-state-file-cache'

let dir = ''

function tempFile(): string {
  dir = mkdtempSync(join(tmpdir(), 'orca-state-file-cache-'))
  return join(dir, 'state.json')
}

afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true })
    dir = ''
  }
})

describe('createIntegrationStateFileCache', () => {
  it('memoizes while the file is unchanged', () => {
    const path = tempFile()
    writeFileSync(path, '1')
    let reads = 0
    const cache = createIntegrationStateFileCache({
      filePath: () => path,
      readFromDisk: () => {
        reads += 1
        return { reads }
      }
    })

    expect(cache.get()).toEqual({ reads: 1 })
    expect(cache.get()).toEqual({ reads: 1 })
    expect(reads).toBe(1)
  })

  it('reloads once the file changes underneath it', () => {
    const path = tempFile()
    writeFileSync(path, 'a')
    const cache = createIntegrationStateFileCache({
      filePath: () => path,
      readFromDisk: () => ({ body: readBody(path) })
    })
    expect(cache.get()).toEqual({ body: 'a' })

    writeFileSync(path, 'bb')

    expect(cache.get()).toEqual({ body: 'bb' })
  })

  it('notices a same-size atomic replacement with the original modification time', () => {
    const path = tempFile()
    writeFileSync(path, 'old')
    const time = new Date('2026-01-01T00:00:00Z')
    utimesSync(path, time, time)
    const cache = createIntegrationStateFileCache({
      filePath: () => path,
      readFromDisk: () => readBody(path)
    })
    expect(cache.get()).toBe('old')
    const replacement = join(dir, 'replacement.json')
    writeFileSync(replacement, 'new')
    utimesSync(replacement, time, time)
    renameSync(replacement, path)
    expect(statSync(path).mtime.getTime()).toBe(time.getTime())
    expect(cache.get()).toBe('new')
  })

  it('distinguishes backing paths when both files are initially absent', () => {
    let path = tempFile()
    let reads = 0
    const cache = createIntegrationStateFileCache({
      filePath: () => path,
      readFromDisk: () => ++reads
    })
    expect(cache.get()).toBe(1)
    path = join(dir, 'another.json')
    expect(cache.get()).toBe(2)
  })

  it('reloads when a file appears after an absent first read', () => {
    const path = tempFile()
    const cache = createIntegrationStateFileCache({
      filePath: () => path,
      readFromDisk: () => ({ present: fileExists(path) })
    })
    expect(cache.get()).toEqual({ present: false })

    writeFileSync(path, 'now here')

    expect(cache.get()).toEqual({ present: true })
  })

  it('reloads when the file is removed', () => {
    const path = tempFile()
    writeFileSync(path, 'a')
    const cache = createIntegrationStateFileCache({
      filePath: () => path,
      readFromDisk: () => ({ present: fileExists(path) })
    })
    expect(cache.get()).toEqual({ present: true })

    rmSync(path)

    expect(cache.get()).toEqual({ present: false })
  })

  it('re-reads after an invalidate so the value and stamp come from the same look', () => {
    const path = tempFile()
    writeFileSync(path, 'a')
    const cache = createIntegrationStateFileCache({
      filePath: () => path,
      readFromDisk: () => ({ body: readBody(path) })
    })
    expect(cache.get()).toEqual({ body: 'a' })

    writeFileSync(path, 'written-by-us')
    cache.invalidate()

    expect(cache.get()).toEqual({ body: 'written-by-us' })
  })

  it('recovers when another process writes between the stamp and the read', () => {
    const path = tempFile()
    writeFileSync(path, 'v1')
    let reads = 0
    let writeDuringRead = false
    const cache = createIntegrationStateFileCache({
      filePath: () => path,
      readFromDisk: () => {
        reads += 1
        if (writeDuringRead) {
          writeDuringRead = false
          writeFileSync(path, 'theirs')
        }
        return { body: readBody(path) }
      }
    })
    expect(cache.get()).toEqual({ body: 'v1' })

    writeFileSync(path, 'ours')
    cache.invalidate()
    writeDuringRead = true

    // Content read after a concurrent write still carries the earlier stamp, forcing one more read.
    expect(cache.get()).toEqual({ body: 'theirs' })
    expect(cache.get()).toEqual({ body: 'theirs' })
    expect(reads).toBe(3)

    expect(cache.get()).toEqual({ body: 'theirs' })
    expect(reads).toBe(3)
  })
})

function readBody(path: string): string {
  return readFileSync(path, 'utf-8')
}

function fileExists(path: string): boolean {
  return existsSync(path)
}
