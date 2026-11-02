import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { walkSessionFiles } from './session-scanner-discovery'

let tempRoot: string | null = null

afterEach(async () => {
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true })
    tempRoot = null
  }
})

describe('walkSessionFiles directory reader', () => {
  it('uses the injected reader for the root and nested directories', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'orca-session-reader-'))
    const nested = join(tempRoot, '2026', '08', '09')
    await mkdir(nested, { recursive: true })
    const rollout = join(nested, 'rollout-session.jsonl')
    await writeFile(rollout, '{}\n')
    const readDirectory = vi.fn((dirPath: string) => readdir(dirPath, { withFileTypes: true }))

    await expect(
      walkSessionFiles(tempRoot, 'codex', [], {
        extensions: new Set(['.jsonl']),
        readDirectory
      })
    ).resolves.toEqual([rollout])
    expect(readDirectory).toHaveBeenCalledTimes(4)
  })

  it('preserves unreadable-directory handling for an injected reader', async () => {
    const readDirectory = vi.fn(async () => {
      throw new Error('unreachable')
    })

    await expect(
      walkSessionFiles('missing', 'codex', [], {
        extensions: new Set(['.jsonl']),
        readDirectory
      })
    ).resolves.toEqual([])
  })

  it('does not turn cancellation into an unreadable-directory miss', async () => {
    const controller = new AbortController()
    const cancelled = new Error('scan cancelled')
    const readDirectory = vi.fn(async () => {
      controller.abort(cancelled)
      throw cancelled
    })

    await expect(
      walkSessionFiles('cancelled', 'codex', [], {
        extensions: new Set(['.jsonl']),
        readDirectory,
        signal: controller.signal
      })
    ).rejects.toBe(cancelled)
  })
})
