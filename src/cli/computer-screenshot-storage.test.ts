import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeComputerScreenshotTempFile } from './computer-screenshot-storage'

const roots: string[] = []
const originalTempDir = process.env.ORCA_COMPUTER_SCREENSHOT_TMPDIR

afterEach(() => {
  if (originalTempDir === undefined) {
    delete process.env.ORCA_COMPUTER_SCREENSHOT_TMPDIR
  } else {
    process.env.ORCA_COMPUTER_SCREENSHOT_TMPDIR = originalTempDir
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('computer screenshot storage', () => {
  it('writes normal screenshot bytes and streams cleanup of expired captures', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-computer-screenshot-'))
    roots.push(root)
    process.env.ORCA_COMPUTER_SCREENSHOT_TMPDIR = root
    const expiredPath = join(root, 'expired-screenshot.png')
    const unrelatedPath = join(root, 'keep.txt')
    writeFileSync(expiredPath, 'old')
    writeFileSync(unrelatedPath, 'keep')
    const expiredAt = new Date(Date.now() - 25 * 60 * 60 * 1000)
    utimesSync(expiredPath, expiredAt, expiredAt)

    const result = writeComputerScreenshotTempFile(
      'rpc/id',
      Buffer.from('png').toString('base64'),
      'png'
    )

    expect(result.outputPath).toBe(join(root, 'rpc_id-screenshot.png'))
    expect(existsSync(result.outputPath)).toBe(true)
    expect(existsSync(expiredPath)).toBe(false)
    expect(existsSync(unrelatedPath)).toBe(true)
  })
})
