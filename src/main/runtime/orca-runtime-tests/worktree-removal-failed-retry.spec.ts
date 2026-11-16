// List failed-delete leftovers with their error; refuse retry until the leftover is gone.
import 'node:fs'
import { readFile, realpath, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import './runtime-test-module-registration.spec'
import { join } from 'node:path'
import '../../git/worktrees/catalog/worktree-listing'
import '../../workspaces/removal/local-worktree-filesystem'

import { removeWorktree } from '../../git/worktrees/removal/worktree-removal'
import '../orca-runtime-test-mocks/setup.spec'
import { tmpdir } from 'node:os'
import { TEST_REPO_ID, TEST_REPO_PATH } from './orca-runtime-test-fixtures.spec'
import { createWorktreeRemovalRuntime } from './orca-runtime-test-scenario-builders.spec'
import {
  _resetPendingWorktreeRemovalsForTests,
  _settlePendingWorktreeRemovalsForTests,
  loadWorktreeRemovalRecords
} from '../../workspaces/removal/worktree-background-removal'
import {
  readWorktreeRemovalRecords,
  writeWorktreeRemovalRecords
} from '../../workspaces/removal/worktree-removal-records'

const FAILURE = "error: failed to delete 'node_modules/a/LICENSE': Operation not permitted"

describe('runtime Delete on a failed delete’s leftover', () => {
  let directory = ''
  let leftover = ''
  let leftoverId = ''

  beforeEach(async () => {
    vi.clearAllMocks()
    directory = await realpath(await mkdtemp(join(tmpdir(), 'orca-runtime-failed-removal-')))
    leftover = join(directory, 'feature')
    leftoverId = `${TEST_REPO_ID}::${leftover}`
    await mkdir(join(leftover, 'node_modules'), { recursive: true })
    await writeWorktreeRemovalRecords(directory, () => [
      {
        worktreeId: leftoverId,
        repoId: TEST_REPO_ID,
        repoPath: TEST_REPO_PATH,
        worktreePath: leftover,
        branch: 'feature',
        head: 'abc',
        deleteBranch: true,
        force: true,
        requestedAt: 1,
        failure: { message: FAILURE, failedAt: 2 }
      }
    ])
    await loadWorktreeRemovalRecords(directory)
  })

  afterEach(async () => {
    await _settlePendingWorktreeRemovalsForTests()
    _resetPendingWorktreeRemovalsForTests()
    await rm(directory, { recursive: true, force: true })
  })

  it('refuses while the folder Git no longer tracks is there, keeping the row', async () => {
    const runtime = createWorktreeRemovalRuntime()
    // The user replaced the leftover with an ordinary folder of their own.
    await rm(leftover, { recursive: true, force: true })
    await mkdir(leftover)
    await writeFile(join(leftover, 'notes.txt'), 'mine')

    for (const force of [false, true]) {
      await expect(
        runtime.removeManagedWorktree(`id:${leftoverId}`, {
          force,
          waitForBackgroundRemoval: false
        })
      ).rejects.toThrow(/folder was left on disk/)
    }
    await _settlePendingWorktreeRemovalsForTests()

    expect(await readFile(join(leftover, 'notes.txt'), 'utf8')).toBe('mine')
    expect(removeWorktree).not.toHaveBeenCalled()
    const detected = await runtime.listDetectedManagedWorktrees(`id:${TEST_REPO_ID}`)
    expect(detected.worktrees.find((row) => row.id === leftoverId)).toMatchObject({
      removalError: FAILURE
    })
    expect(await readWorktreeRemovalRecords(directory)).toMatchObject([
      { worktreeId: leftoverId, failure: { message: FAILURE } }
    ])
  })

  it('keeps the failure after manual folder removal until explicit retry finishes cleanup', async () => {
    const runtime = createWorktreeRemovalRuntime()
    await rm(leftover, { recursive: true, force: true })

    const detected = await runtime.listDetectedManagedWorktrees(`id:${TEST_REPO_ID}`)
    expect(detected.worktrees.find((row) => row.id === leftoverId)).toMatchObject({
      removalError: FAILURE
    })
    await runtime.removeManagedWorktree(`id:${leftoverId}`, { waitForBackgroundRemoval: true })
    await _settlePendingWorktreeRemovalsForTests()
    expect(
      (await runtime.listDetectedManagedWorktrees(`id:${TEST_REPO_ID}`)).worktrees.find(
        (row) => row.id === leftoverId
      )
    ).toBeUndefined()
    expect(await readWorktreeRemovalRecords(directory)).toEqual([])
    expect(removeWorktree).not.toHaveBeenCalled()
  })
})
