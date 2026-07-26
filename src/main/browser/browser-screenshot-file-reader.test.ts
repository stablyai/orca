import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readBrowserScreenshotFile } from './browser-screenshot-file-reader'
import { BROWSER_SCREENSHOT_MEMORY_LIMIT_ERROR } from './browser-screenshot-limits'

const temporaryDirectories: string[] = []

function createFile(bytes: Buffer): string {
  const directory = mkdtempSync(join(tmpdir(), 'orca-screenshot-reader-'))
  temporaryDirectories.push(directory)
  const path = join(directory, 'screenshot.png')
  writeFileSync(path, bytes)
  return path
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('readBrowserScreenshotFile', () => {
  it('reads a screenshot at the byte boundary', () => {
    const path = createFile(Buffer.from('1234'))

    expect(readBrowserScreenshotFile(path, 4)).toEqual(Buffer.from('1234'))
  })

  it('rejects an oversized screenshot before allocating its contents', () => {
    const path = createFile(Buffer.from('12345'))

    expect(() => readBrowserScreenshotFile(path, 4)).toThrow(BROWSER_SCREENSHOT_MEMORY_LIMIT_ERROR)
  })
})
