import { mkdtemp, readFile, readdir, rm, stat, utimes } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { ipcHandle, isTrustedUIRenderer } = vi.hoisted(() => ({
  ipcHandle: vi.fn(),
  isTrustedUIRenderer: vi.fn(() => true)
}))

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/test/user-data') },
  ipcMain: { handle: ipcHandle }
}))
vi.mock('./ui', () => ({ isTrustedUIRenderer }))

import { writeTerminalRenderDesyncEvidence } from './terminal-render-desync-evidence'

const tempDirectories: string[] = []

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((dir) => rm(dir, { recursive: true })))
})

describe('writeTerminalRenderDesyncEvidence', () => {
  it('writes private PNG and metadata files under app-owned user data', async () => {
    const userData = await mkdtemp(path.join(os.tmpdir(), 'orca-render-desync-'))
    tempDirectories.push(userData)
    const result = await writeTerminalRenderDesyncEvidence(userData, {
      captureId: 'capture-1',
      phase: 'corrupt',
      pngDataUrl: `data:image/png;base64,${Buffer.from('png-bytes').toString('base64')}`,
      metadata: { bufferText: 'private terminal text' }
    })

    expect(await readFile(result.pngPath, 'utf8')).toBe('png-bytes')
    expect(JSON.parse(await readFile(result.metadataPath!, 'utf8'))).toEqual({
      bufferText: 'private terminal text'
    })
    if (process.platform !== 'win32') {
      expect((await stat(result.directory)).mode & 0o777).toBe(0o700)
      expect((await stat(result.pngPath)).mode & 0o777).toBe(0o600)
    }
  })

  it('retains only the newest four capture directories', async () => {
    const userData = await mkdtemp(path.join(os.tmpdir(), 'orca-render-desync-'))
    tempDirectories.push(userData)
    const oldestCaptureTime = Date.now() - 60_000
    for (let capture = 1; capture <= 6; capture++) {
      const result = await writeTerminalRenderDesyncEvidence(userData, {
        captureId: `capture-${capture}`,
        phase: 'corrupt',
        pngDataUrl: 'data:image/png;base64,eA=='
      })
      // Space capture times beyond FAT's two-second mtime resolution.
      const capturedAt = new Date(oldestCaptureTime + capture * 5000)
      await utimes(result.directory, capturedAt, capturedAt)
    }

    const captures = await readdir(path.join(userData, 'terminal-render-desync-evidence'))
    expect(captures.sort()).toEqual(['capture-3', 'capture-4', 'capture-5', 'capture-6'])
  })
})
