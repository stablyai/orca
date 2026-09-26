import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GitRunner from './runner'

type GitCall = { stdin?: string; cwd?: string; timeout?: number }

const gitExecFileAsyncMock = vi.hoisted(() =>
  vi.fn<(argv: string[], options: GitCall) => Promise<{ stdout: string; stderr: string }>>()
)

vi.mock('./runner', async (importOriginal) => ({
  ...(await importOriginal<typeof GitRunner>()),
  gitExecFileAsync: gitExecFileAsyncMock
}))

import {
  LOOSE_OBJECT_PACK_KEEP_CONTENT,
  LOOSE_OBJECT_PACK_THRESHOLD
} from '../../shared/repo-maintenance-policy'
import { createPackLooseObjectsMaintenanceTask } from './pack-loose-objects-maintenance-task'

const NO_ABORT = new AbortController().signal
const NO_LOCK = { setHeld: () => {} }
const roots: string[] = []

function objectId(index: number): string {
  return index.toString(16).padStart(40, '0')
}

/** A repository whose only loose-object backlog is the one the test asks for. */
async function repoWithLooseObjects(count: number): Promise<{
  repoPath: string
  commonDir: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'orca-loose-object-task-'))
  roots.push(root)
  const commonDir = join(root, 'repo', '.git')
  await mkdir(join(commonDir, 'objects', 'pack'), { recursive: true })
  for (let index = 0; index < count; index += 1) {
    const id = objectId(index)
    await mkdir(join(commonDir, 'objects', id.slice(0, 2)), { recursive: true })
    await writeFile(join(commonDir, 'objects', id.slice(0, 2), id.slice(2)), 'x')
  }
  return { repoPath: join(root, 'repo'), commonDir }
}

function taskFor(
  repoPath: string,
  commonDir: string | undefined,
  overrides: { batchSize?: number; threshold?: number } = {}
): ReturnType<typeof createPackLooseObjectsMaintenanceTask> {
  return createPackLooseObjectsMaintenanceTask({
    repoPath,
    resolveCommonDir: async () => commonDir,
    ...overrides
  })
}

beforeEach(() => {
  gitExecFileAsyncMock.mockReset()
  gitExecFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('loose-object maintenance task', () => {
  it('probes the object store without running Git at all', async () => {
    const { repoPath, commonDir } = await repoWithLooseObjects(12)

    await expect(taskFor(repoPath, commonDir).probeBacklog(100, NO_ABORT)).resolves.toEqual({
      count: 12,
      saturated: false
    })
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('carries the shipped threshold', () => {
    expect(taskFor('/repo', '/repo/.git').threshold).toBe(LOOSE_OBJECT_PACK_THRESHOLD)
  })

  it('packs the named objects and drops the loose copies', async () => {
    const { repoPath, commonDir } = await repoWithLooseObjects(3)

    const report = await taskFor(repoPath, commonDir).pack(NO_LOCK)

    const calls = gitExecFileAsyncMock.mock.calls
    expect(calls.map((call) => call[0][0])).toEqual([
      'prune-packed',
      'pack-objects',
      'prune-packed'
    ])
    const packCall = calls[1]
    expect(packCall[0]).toEqual([
      'pack-objects',
      '--quiet',
      '--non-empty',
      join(commonDir, 'objects', 'pack', 'loose')
    ])
    // The object ids go in on stdin, so no history is walked and nothing is
    // judged by reachability -- which is what lets this pack unreachable objects.
    expect(packCall[1].stdin?.trim().split('\n').sort()).toEqual([
      objectId(0),
      objectId(1),
      objectId(2)
    ])
    expect(packCall[1].cwd).toBe(repoPath)
    expect(report).toEqual({ batchExhausted: false })
  })

  it('keeps the pack it wrote before dropping the loose copies', async () => {
    const { repoPath, commonDir } = await repoWithLooseObjects(3)
    const hash = 'ab'.repeat(20)
    const keepPath = join(commonDir, 'objects', 'pack', `loose-${hash}.keep`)
    let keptBeforePrune: string | undefined
    gitExecFileAsyncMock.mockImplementation(async (argv) => {
      if (argv[0] === 'pack-objects') {
        return { stdout: `${hash}\n`, stderr: '' }
      }
      if (gitExecFileAsyncMock.mock.calls.length > 1) {
        keptBeforePrune = await readFile(keepPath, 'utf8').catch(() => undefined)
      }
      return { stdout: '', stderr: '' }
    })

    await taskFor(repoPath, commonDir).pack(NO_LOCK)

    expect(keptBeforePrune).toBe(LOOSE_OBJECT_PACK_KEEP_CONTENT)
  })

  it('never persists anything into the user Git config', async () => {
    const { repoPath, commonDir } = await repoWithLooseObjects(3)

    await taskFor(repoPath, commonDir).pack(NO_LOCK)

    for (const call of gitExecFileAsyncMock.mock.calls) {
      expect(call[0]).not.toContain('config')
    }
  })

  it('takes at most one batch and says the batch was spent', async () => {
    const { repoPath, commonDir } = await repoWithLooseObjects(25)

    const report = await taskFor(repoPath, commonDir, { batchSize: 10 }).pack(NO_LOCK)

    const stdin = gitExecFileAsyncMock.mock.calls[1][1].stdin ?? ''
    expect(stdin.trim().split('\n')).toHaveLength(10)
    expect(report).toEqual({ batchExhausted: true })
  })

  it('reports a batch that emptied the store as not exhausted', async () => {
    const { repoPath, commonDir } = await repoWithLooseObjects(10)

    await expect(taskFor(repoPath, commonDir, { batchSize: 10 }).pack(NO_LOCK)).resolves.toEqual({
      // Exactly a full batch, but nothing is left behind, so nothing is owed.
      batchExhausted: false
    })
  })

  it('writes no pack when the prune left nothing loose', async () => {
    const { repoPath, commonDir } = await repoWithLooseObjects(0)

    const report = await taskFor(repoPath, commonDir).pack(NO_LOCK)

    expect(gitExecFileAsyncMock.mock.calls.map((call) => call[0][0])).toEqual(['prune-packed'])
    expect(report).toEqual({ batchExhausted: false })
  })

  it('does nothing at all for a repository it cannot resolve', async () => {
    const task = taskFor('/repo', undefined)

    await expect(task.probeBacklog(100, NO_ABORT)).resolves.toBeUndefined()
    await expect(task.pack(NO_LOCK)).resolves.toEqual({ batchExhausted: false })
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })
})
