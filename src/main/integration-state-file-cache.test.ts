import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

  it('reloads when a file appears after an absent first read', () => {
    // The desktop app commonly starts before any integration is connected.
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
    // The stamp is taken before the content, so a writer landing inside that
    // window leaves fresh content under a stale stamp. That must self-correct on
    // the next read rather than pin the value, which is what stamping our own
    // write would have done.
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

    // Reads 'theirs' but stamped against 'ours', so the next look must reload.
    expect(cache.get()).toEqual({ body: 'theirs' })
    expect(cache.get()).toEqual({ body: 'theirs' })
    expect(reads).toBe(3)

    // Stamp and content now agree, so a further look is served from memory.
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
