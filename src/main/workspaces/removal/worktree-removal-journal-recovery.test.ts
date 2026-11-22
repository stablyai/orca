import type * as FsPromises from 'node:fs/promises'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeRemovalRecord } from './worktree-removal-records'

let readFileFault: { path: string; code: string } | null = null
let renameFault: { path: string; code: string } | null = null

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  return {
    ...actual,
    readFile: async (path: Parameters<typeof actual.readFile>[0], ...rest: unknown[]) => {
      if (readFileFault && String(path) === readFileFault.path) {
        throw Object.assign(new Error(`${readFileFault.code}: readFile ${String(path)}`), {
          code: readFileFault.code
        })
      }
      return (actual.readFile as (...args: unknown[]) => Promise<unknown>)(path, ...rest)
    },
    rename: async (
      oldPath: Parameters<typeof actual.rename>[0],
      newPath: Parameters<typeof actual.rename>[1]
    ) => {
      if (renameFault && String(oldPath) === renameFault.path) {
        throw Object.assign(new Error(`${renameFault.code}: rename ${String(oldPath)}`), {
          code: renameFault.code
        })
      }
      return actual.rename(oldPath, newPath)
    }
  }
})

const recordA: WorktreeRemovalRecord = {
  worktreeId: 'repo-1::/work/alpha',
  repoId: 'repo-1',
  repoPath: '/work/repo',
  worktreePath: '/work/alpha',
  branch: 'alpha',
  head: 'aaa111',
  deleteBranch: true,
  force: false,
  requestedAt: 100
}

const recordB: WorktreeRemovalRecord = {
  worktreeId: 'repo-1::/work/beta',
  repoId: 'repo-1',
  repoPath: '/work/repo',
  worktreePath: '/work/beta',
  branch: 'beta',
  head: 'bbb222',
  deleteBranch: false,
  force: false,
  requestedAt: 200
}

const recordC: WorktreeRemovalRecord = {
  worktreeId: 'repo-1::/work/gamma',
  repoId: 'repo-1',
  repoPath: '/work/repo',
  worktreePath: '/work/gamma',
  branch: 'gamma',
  head: 'ccc333',
  deleteBranch: false,
  force: false,
  requestedAt: 300
}

async function importFreshModules() {
  vi.resetModules()
  const [background, records, table] = await Promise.all([
    import('./worktree-background-removal'),
    import('./worktree-removal-records'),
    import('./worktree-removal-table')
  ])
  return { ...background, ...records, ...table }
}

async function corruptBackupsIn(dir: string, file: string): Promise<string[]> {
  const prefix = `${basename(file)}.corrupt-`
  const entries = await readdir(dir)
  return entries.filter((name) => name.startsWith(prefix)).sort()
}

let directory = ''

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-worktree-removal-journal-'))
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(async () => {
  readFileFault = null
  renameFault = null
  vi.restoreAllMocks()
  await rm(directory, { recursive: true, force: true })
})

describe('worktree removal journal recovery', () => {
  it('moves an unreadable journal aside before admitting a new deletion and refuses overwrite if rename fails', async () => {
    const firstBoot = await importFreshModules()
    expect(await firstBoot.loadWorktreeRemovalRecords(directory)).toEqual({
      status: 'missing',
      records: []
    })
    expect(firstBoot.getWorktreeRemovalJournalState()).toEqual({ status: 'ready', directory })
    await firstBoot.writeWorktreeRemovalRecords(directory, () => [recordA])
    const file = firstBoot.worktreeRemovalRecordsFile(directory)
    const originalBytes = await readFile(file, 'utf-8')
    expect(await corruptBackupsIn(directory, file)).toEqual([])

    // Fresh startup cannot read the existing journal (EACCES).
    const nextBoot = await importFreshModules()
    readFileFault = { path: file, code: 'EACCES' }
    expect(await nextBoot.loadWorktreeRemovalRecords(directory)).toMatchObject({
      status: 'unavailable',
      reason: 'unreadable',
      file
    })
    expect(nextBoot.getWorktreeRemovalJournalState()).toMatchObject({
      status: 'degraded',
      directory,
      file,
      reason: 'unreadable'
    })

    // An idle persist must not disturb the existing file before any deletion is admitted.
    readFileFault = null
    await nextBoot.persistWorktreeRemovalRecords()
    expect(await readFile(file, 'utf-8')).toBe(originalBytes)
    expect(await corruptBackupsIn(directory, file)).toEqual([])

    // If moving the bad journal aside fails, refuse the write rather than overwriting original bytes.
    renameFault = { path: file, code: 'EIO' }
    await expect(nextBoot.recordWorktreeRemoval(recordB)).rejects.toThrow(/EIO/)
    expect(await readFile(file, 'utf-8')).toBe(originalBytes)
    expect(nextBoot.getWorktreeRemovalJournalState()).toMatchObject({ status: 'degraded' })

    // Once rename succeeds, admission moves the old journal aside and writes a fresh one.
    renameFault = null
    nextBoot.pendingWorktreeRemovals.set(recordB.worktreeId, recordB)
    await nextBoot.recordWorktreeRemoval(recordB)
    expect(nextBoot.getWorktreeRemovalJournalState()).toEqual({ status: 'ready', directory })

    const backups = await corruptBackupsIn(directory, file)
    expect(backups).toHaveLength(1)
    expect(await readFile(join(directory, backups[0]), 'utf-8')).toBe(originalBytes)
    expect((await nextBoot.readWorktreeRemovalRecords(directory)).map((r) => r.worktreeId)).toEqual(
      [recordB.worktreeId]
    )

    // Subsequent admissions write normally without creating extra backups.
    nextBoot.pendingWorktreeRemovals.set(recordC.worktreeId, recordC)
    await nextBoot.recordWorktreeRemoval(recordC)
    expect(await corruptBackupsIn(directory, file)).toEqual(backups)
    expect((await nextBoot.readWorktreeRemovalRecords(directory)).map((r) => r.worktreeId)).toEqual(
      [recordB.worktreeId, recordC.worktreeId]
    )
    await nextBoot.drainBackgroundWorktreeRemovals()
  })

  it.each([
    { label: 'malformed JSON', contents: '{corrupt-json', reason: 'malformed' as const },
    {
      label: 'unsupported version',
      contents: JSON.stringify({ version: 2, removals: [] }),
      reason: 'unsupported-version' as const
    }
  ])(
    'keeps deletions working and moves $label aside to a .corrupt backup before writing',
    async ({ contents, reason }) => {
      const mods = await importFreshModules()
      const file = mods.worktreeRemovalRecordsFile(directory)
      await writeFile(file, contents, 'utf-8')

      expect(await mods.loadWorktreeRemovalRecords(directory)).toMatchObject({
        status: 'unavailable',
        reason,
        file
      })
      await mods.recordWorktreeRemoval(recordB)

      const backups = await corruptBackupsIn(directory, file)
      expect(backups).toHaveLength(1)
      expect(await readFile(join(directory, backups[0]), 'utf-8')).toBe(contents)
      expect((await mods.readWorktreeRemovalRecords(directory)).map((r) => r.worktreeId)).toEqual([
        recordB.worktreeId
      ])
      await mods.drainBackgroundWorktreeRemovals()
    }
  )

  it('restores valid entries from a partially malformed journal while preserving the original file before rewriting', async () => {
    const mods = await importFreshModules()
    const file = mods.worktreeRemovalRecordsFile(directory)
    const contents = JSON.stringify({ version: 1, removals: [recordA, { worktreeId: 123 }] })
    await writeFile(file, contents, 'utf-8')

    expect(await mods.loadWorktreeRemovalRecords(directory)).toEqual({
      status: 'partial',
      records: [recordA],
      droppedCount: 1,
      file
    })
    expect(mods.waitForPendingWorktreeRemoval(recordA.worktreeId)).toBeDefined()

    await mods.recordWorktreeRemoval(recordB)

    const backups = await corruptBackupsIn(directory, file)
    expect(backups).toHaveLength(1)
    expect(await readFile(join(directory, backups[0]), 'utf-8')).toBe(contents)
    expect((await mods.readWorktreeRemovalRecords(directory)).map((r) => r.worktreeId)).toEqual([
      recordA.worktreeId,
      recordB.worktreeId
    ])
    mods.releaseStartupRemovalFence(recordA.worktreeId)
    await mods.drainBackgroundWorktreeRemovals()
  })
})
