import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverFiles, walkSessionFiles } from './session-scanner-discovery'

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

  it('shares entry and stat budgets across bounded discovery', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'orca-session-budget-'))
    await Promise.all(
      Array.from({ length: 4 }, (_, index) => writeFile(join(tempRoot!, `${index}.jsonl`), '{}\n'))
    )
    const budget = {
      entriesRemaining: 3,
      filesRemaining: 2,
      truncated: false,
      entriesTruncated: false,
      filesTruncated: false,
      directoriesRead: 0,
      direntsRead: 0
    }

    const result = await discoverFiles({
      rootDir: tempRoot,
      limit: 10,
      agent: 'cursor',
      issues: [],
      extensions: ['.jsonl'],
      budget
    })

    expect(result.files).toHaveLength(2)
    expect(budget).toEqual({
      entriesRemaining: 0,
      filesRemaining: 0,
      truncated: true,
      entriesTruncated: true,
      filesTruncated: true,
      directoriesRead: 1,
      direntsRead: 4
    })
  })

  it('charges nested dirents when read instead of after recursive descent', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'orca-session-nested-budget-'))
    await Promise.all(
      ['a', 'b'].map(async (directory) => {
        const nested = join(tempRoot!, directory)
        await mkdir(nested)
        await Promise.all(
          Array.from({ length: 4 }, (_, index) => writeFile(join(nested, `${index}.jsonl`), '{}\n'))
        )
      })
    )
    const budget = {
      entriesRemaining: 4,
      filesRemaining: 4,
      truncated: false,
      entriesTruncated: false,
      filesTruncated: false,
      directoriesRead: 0,
      direntsRead: 0
    }

    const result = await discoverFiles({
      rootDir: tempRoot,
      limit: 10,
      agent: 'cursor',
      issues: [],
      extensions: ['.jsonl'],
      budget
    })

    expect(result.files).toHaveLength(2)
    expect(budget.entriesRemaining).toBe(0)
    expect(budget.direntsRead).toBe(5)
    expect(budget.directoriesRead).toBe(2)
    expect(budget.entriesTruncated).toBe(true)
  })

  it('stops a bounded directory read when cancellation lands during an entry read', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'orca-session-cancel-budget-'))
    await Promise.all(
      Array.from({ length: 4 }, (_, index) => writeFile(join(tempRoot!, `${index}.jsonl`), '{}\n'))
    )
    const controller = new AbortController()
    const cancelled = new Error('scan cancelled during directory read')
    const originalThrowIfAborted = controller.signal.throwIfAborted.bind(controller.signal)
    let checks = 0
    vi.spyOn(controller.signal, 'throwIfAborted').mockImplementation(() => {
      checks += 1
      if (checks === 3) {
        controller.abort(cancelled)
      }
      originalThrowIfAborted()
    })
    const budget = {
      entriesRemaining: 4,
      filesRemaining: 4,
      truncated: false,
      entriesTruncated: false,
      filesTruncated: false,
      directoriesRead: 0,
      direntsRead: 0
    }

    await expect(
      discoverFiles({
        rootDir: tempRoot,
        limit: 4,
        agent: 'cursor',
        issues: [],
        extensions: ['.jsonl'],
        signal: controller.signal,
        budget
      })
    ).rejects.toBe(cancelled)

    expect(budget.entriesRemaining).toBe(4)
    expect(budget.filesRemaining).toBe(4)
    expect(budget.directoriesRead).toBe(1)
    expect(budget.direntsRead).toBe(1)
  })
})
