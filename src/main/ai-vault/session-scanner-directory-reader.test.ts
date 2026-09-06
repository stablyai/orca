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

it('visits file contents before descending further without retaining paths', async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'orca-session-stream-'))
  await writeFile(join(tempRoot, 'first.jsonl'), '{}\n')
  await mkdir(join(tempRoot, 'nested'))
  await writeFile(join(tempRoot, 'nested', 'second.jsonl'), '{}\n')
  const visited: string[] = []
  const readDirectory = vi.fn(async (path: string) => {
    if (path.endsWith('nested')) {
      expect(visited).toEqual([join(tempRoot!, 'first.jsonl')])
    }
    return (await readdir(path, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name)
    )
  })
  const retained = await walkSessionFiles(tempRoot, 'claude', [], {
    extensions: new Set(['.jsonl']),
    readDirectory,
    onFile: async (path) => {
      visited.push(path)
    }
  })
  expect(retained).toEqual([])
  expect(visited).toHaveLength(2)
})
