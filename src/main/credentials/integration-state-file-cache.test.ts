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
})

function readBody(path: string): string {
  return readFileSync(path, 'utf-8')
}

function fileExists(path: string): boolean {
  return existsSync(path)
}
