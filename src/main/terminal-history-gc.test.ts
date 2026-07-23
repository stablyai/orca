import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  deleteWslWorktreeHistoryDirectories,
  runTerminalHistoryGarbageCollection,
  TERMINAL_HISTORY_GC_META_MAX_BYTES
} from './terminal-history-gc'

let root = ''
let mainRoot = ''
let wslRoot = ''

function oldMetadata(worktreeId: string): string {
  return JSON.stringify({
    worktreeId,
    createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString()
  })
}

async function createHistoryDirectory(
  historyRoot: string,
  directoryName: string,
  worktreeId = directoryName
): Promise<string> {
  const directory = join(historyRoot, directoryName)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'meta.json'), oldMetadata(worktreeId))
  return directory
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-terminal-history-gc-'))
  mainRoot = join(root, 'terminal-history')
  wslRoot = join(root, 'terminal-history-wsl')
  await mkdir(mainRoot)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

describe('terminal history GC memory limits', () => {
  it('preserves ordinary live/orphan and age-guard behavior below the limits', async () => {
    const liveDirectory = await createHistoryDirectory(mainRoot, 'live-dir', 'live-worktree')
    const orphanDirectory = await createHistoryDirectory(mainRoot, 'orphan-dir', 'orphan-worktree')
    const freshDirectory = await createHistoryDirectory(mainRoot, 'fresh-dir', 'fresh-worktree')
    await writeFile(
      join(freshDirectory, 'meta.json'),
      JSON.stringify({ worktreeId: 'fresh-worktree', createdAt: new Date().toISOString() })
    )

    const summary = runTerminalHistoryGarbageCollection({
      mainRoot,
      wslRoot,
      liveWorktreeIds: new Set(['live-worktree'])
    })

    expect(summary).toMatchObject({
      capacityExceeded: false,
      orphaned: 1,
      pruned: 1,
      totalDirs: 3
    })
    expect(existsSync(liveDirectory)).toBe(true)
    expect(existsSync(freshDirectory)).toBe(true)
    expect(existsSync(orphanDirectory)).toBe(false)
  })

  it('accepts metadata at the exact byte limit and skips one byte over', async () => {
    const exactDirectory = await createHistoryDirectory(mainRoot, 'exact-dir', 'exact-worktree')
    const exactMetaPath = join(exactDirectory, 'meta.json')
    const exactJson = oldMetadata('exact-worktree')
    await writeFile(
      exactMetaPath,
      `${exactJson}${' '.repeat(TERMINAL_HISTORY_GC_META_MAX_BYTES - exactJson.length)}`
    )

    expect(
      runTerminalHistoryGarbageCollection({
        mainRoot,
        wslRoot,
        liveWorktreeIds: new Set()
      }).pruned
    ).toBe(1)

    const oversizedDirectory = await createHistoryDirectory(
      mainRoot,
      'oversized-dir',
      'oversized-worktree'
    )
    const oversizedMetaPath = join(oversizedDirectory, 'meta.json')
    await writeFile(oversizedMetaPath, oldMetadata('oversized-worktree'))
    await truncate(oversizedMetaPath, TERMINAL_HISTORY_GC_META_MAX_BYTES + 8 * 1024 * 1024)

    expect(
      runTerminalHistoryGarbageCollection({
        mainRoot,
        wslRoot,
        liveWorktreeIds: new Set()
      }).pruned
    ).toBe(0)
    expect(existsSync(oversizedDirectory)).toBe(true)
  })

  it('accepts the exact discovery-entry budget and stops before the next entry', async () => {
    await createHistoryDirectory(mainRoot, 'one')
    await createHistoryDirectory(mainRoot, 'two')

    const exact = runTerminalHistoryGarbageCollection({
      mainRoot,
      wslRoot,
      liveWorktreeIds: new Set(),
      limits: { maxDiscoveryEntries: 4 }
    })
    expect(exact).toMatchObject({ capacityExceeded: false, pruned: 2 })

    await createHistoryDirectory(mainRoot, 'one')
    await createHistoryDirectory(mainRoot, 'two')
    await createHistoryDirectory(mainRoot, 'three')
    const capped = runTerminalHistoryGarbageCollection({
      mainRoot,
      wslRoot,
      liveWorktreeIds: new Set(),
      limits: { maxDiscoveryEntries: 4 }
    })
    expect(capped.capacityExceeded).toBe(true)
    expect(
      [join(mainRoot, 'one'), join(mainRoot, 'two'), join(mainRoot, 'three')].some(existsSync)
    ).toBe(true)
  })

  it('fails closed when a worktree directory exceeds its flat-file limit', async () => {
    const directory = await createHistoryDirectory(mainRoot, 'many-files')
    for (let index = 0; index < 100; index += 1) {
      await writeFile(join(directory, `history-${index}`), 'x')
    }

    const summary = runTerminalHistoryGarbageCollection({
      mainRoot,
      wslRoot,
      liveWorktreeIds: new Set(),
      limits: { maxFilesPerWorktree: 1 }
    })

    expect(summary).toMatchObject({ capacityExceeded: false, pruned: 0 })
    expect(existsSync(directory)).toBe(true)
  })

  it('does not recursively prune an unexpected nested history tree', async () => {
    const directory = await createHistoryDirectory(mainRoot, 'nested-tree')
    await mkdir(join(directory, 'unexpected', 'deep'), { recursive: true })

    const summary = runTerminalHistoryGarbageCollection({
      mainRoot,
      wslRoot,
      liveWorktreeIds: new Set()
    })

    expect(summary).toMatchObject({ capacityExceeded: false, pruned: 0 })
    expect(existsSync(directory)).toBe(true)
  })

  it('caps WSL distro roots for both GC and direct worktree cleanup', async () => {
    const first = join(wslRoot, 'Distro-A')
    const second = join(wslRoot, 'Distro-B')
    let firstHistory = await createHistoryDirectory(first, 'hash', 'first-worktree')
    let secondHistory = await createHistoryDirectory(second, 'hash', 'second-worktree')

    const exactSummary = runTerminalHistoryGarbageCollection({
      mainRoot,
      wslRoot,
      liveWorktreeIds: new Set(),
      limits: { maxWslDistros: 2 }
    })
    expect(exactSummary).toMatchObject({ capacityExceeded: false, pruned: 2 })

    firstHistory = await createHistoryDirectory(first, 'hash', 'first-worktree')
    secondHistory = await createHistoryDirectory(second, 'hash', 'second-worktree')
    const cappedSummary = runTerminalHistoryGarbageCollection({
      mainRoot,
      wslRoot,
      liveWorktreeIds: new Set(),
      limits: { maxWslDistros: 1 }
    })
    expect(cappedSummary.capacityExceeded).toBe(true)
    expect([firstHistory, secondHistory].some(existsSync)).toBe(true)

    await mkdir(firstHistory, { recursive: true })
    await mkdir(secondHistory, { recursive: true })
    deleteWslWorktreeHistoryDirectories({
      wslRoot,
      worktreeHash: 'hash',
      limits: { maxWslDistros: 2 }
    })
    expect(existsSync(firstHistory)).toBe(false)
    expect(existsSync(secondHistory)).toBe(false)

    await mkdir(firstHistory, { recursive: true })
    await mkdir(secondHistory, { recursive: true })
    deleteWslWorktreeHistoryDirectories({
      wslRoot,
      worktreeHash: 'hash',
      limits: { maxWslDistros: 1 }
    })
    expect([firstHistory, secondHistory].some(existsSync)).toBe(true)
  })
})
