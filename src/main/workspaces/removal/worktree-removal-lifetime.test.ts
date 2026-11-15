import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  _resetPendingWorktreeRemovalsForTests,
  _settlePendingWorktreeRemovalsForTests,
  startBackgroundWorktreeRemoval,
  resumeInterruptedWorktreeRemovals,
  waitForWorktreeRemovalAcceptance
} from './worktree-background-removal'
import { prepareWorktreeRemovalsForStore } from './worktree-removal-records-load'
import { worktreeRemovalLifetime } from './worktree-removal-lifetime'
import {
  readWorktreeRemovalRecords,
  worktreeRemovalRecordsFile,
  writeWorktreeRemovalRecords
} from './worktree-removal-records'
import {
  assertNoPendingWorktreeRemovalConflict,
  persistWorktreeRemovalRecords
} from './worktree-removal-table'
import { withSidecarSnapshotQueue } from '../../filesystem/sidecar-snapshot-file'
import * as failureInspection from './worktree-removal-failure'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const removal = {
  worktreeId: 'repo::feature',
  repoId: 'repo',
  repoPath: '/unused/repo',
  worktree: { path: '/unused/feature', branch: 'feature', head: 'abc' },
  deleteBranch: false,
  force: true
}
let directory = ''
const prepare = () =>
  prepareWorktreeRemovalsForStore({
    getProfileStorageDirectory: () => directory,
    getRepos: () => [{ id: 'repo' }]
  })
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-removal-lifetime-'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  _resetPendingWorktreeRemovalsForTests()
  await rm(directory, { recursive: true, force: true })
})

it('lets owned teardown admit during close without running cleanup, and recovers its saved choices', async () => {
  await prepare()
  const release = worktreeRemovalLifetime.acquirePreparation()
  const closing = worktreeRemovalLifetime.close()
  expect(worktreeRemovalLifetime.close()).toBe(closing)
  expect(() => worktreeRemovalLifetime.acquirePreparation()).toThrow('Orca is stopping')
  const run = vi.fn(async () => ({}))
  void startBackgroundWorktreeRemoval({ removal, run, publish: () => {} })
  release()
  await waitForWorktreeRemovalAcceptance(removal.worktreeId)
  await closing
  expect(run).not.toHaveBeenCalled()
  expect(await readWorktreeRemovalRecords(directory)).toEqual([
    expect.objectContaining({
      worktreeId: 'repo::feature',
      force: true,
      deleteBranch: false
    })
  ])
  _resetPendingWorktreeRemovalsForTests()
  await prepare()
  resumeInterruptedWorktreeRemovals(() => ({ run, publish: () => {} }))
  await _settlePendingWorktreeRemovalsForTests()
  expect(run).toHaveBeenCalledOnce()
  expect(await readWorktreeRemovalRecords(directory)).toEqual([])
})

it('keeps failure writes live through inspection and parks that failure across restart', async () => {
  await prepare()
  const inspecting = deferred()
  const inspected = deferred()
  vi.spyOn(failureInspection, 'failureLeftByGit').mockImplementation(async () => {
    inspecting.resolve()
    await inspected.promise
    return { message: 'Files are in use. Retry deletion.', failedAt: 123 }
  })
  const result = startBackgroundWorktreeRemoval({
    removal,
    run: async () => {
      throw new Error('files in use')
    },
    publish: () => {}
  })
  const refused = expect(result).rejects.toThrow('files in use')
  await inspecting.promise
  const closing = worktreeRemovalLifetime.close()
  inspected.resolve()
  await closing
  await refused
  _resetPendingWorktreeRemovalsForTests()
  await prepare()
  const run = vi.fn(async () => ({}))
  resumeInterruptedWorktreeRemovals(() => ({ run, publish: () => {} }))
  expect(run).not.toHaveBeenCalled()
  expect(() =>
    assertNoPendingWorktreeRemovalConflict('/unused/repo', { branch: 'feature' })
  ).toThrow('Cleanup failed')
  expect(await readWorktreeRemovalRecords(directory)).toEqual([
    expect.objectContaining({
      failure: { message: 'Files are in use. Retry deletion.', failedAt: 123 }
    })
  ])
})

it('does not start deferred loaded recovery after close, but retains it for the next host', async () => {
  const { worktree, ...fields } = removal
  await writeWorktreeRemovalRecords(directory, () => [
    { ...fields, worktreePath: worktree.path, branch: 'feature', head: 'abc', requestedAt: 1 }
  ])
  await prepare()
  const queuedCallback = () =>
    worktreeRemovalLifetime.resume(() =>
      resumeInterruptedWorktreeRemovals(() => ({
        run: async () => {
          throw new Error('late recovery ran')
        },
        publish: () => {}
      }))
    )
  await worktreeRemovalLifetime.close()
  queuedCallback()
  expect(await readWorktreeRemovalRecords(directory)).toHaveLength(1)
  _resetPendingWorktreeRemovalsForTests()
  await prepare()
  resumeInterruptedWorktreeRemovals(() => ({ run: async () => ({}), publish: () => {} }))
  await _settlePendingWorktreeRemovalsForTests()
  expect(await readWorktreeRemovalRecords(directory)).toEqual([])
})

it('joins listing writes outside jobs and seals submissions before a successor writes', async () => {
  await prepare()
  const writer = deferred()
  const entered = deferred()
  void withSidecarSnapshotQueue(worktreeRemovalRecordsFile(directory), async () => {
    entered.resolve()
    await writer.promise
  })
  await entered.promise
  void persistWorktreeRemovalRecords()
  let released = false
  const closing = worktreeRemovalLifetime.close().then(() => {
    released = true
  })
  await Promise.resolve()
  expect(released).toBe(false)
  writer.resolve()
  await closing
  await writeWorktreeRemovalRecords(directory, () => [
    {
      worktreeId: 'successor',
      repoId: 'repo',
      repoPath: '/next',
      worktreePath: '/next/feature',
      branch: 'next',
      head: 'def',
      force: false,
      deleteBranch: false,
      requestedAt: 2
    }
  ])
  await persistWorktreeRemovalRecords()
  expect(await readWorktreeRemovalRecords(directory)).toEqual([
    expect.objectContaining({ worktreeId: 'successor' })
  ])
})
