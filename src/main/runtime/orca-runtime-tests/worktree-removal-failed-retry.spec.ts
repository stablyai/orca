// A runtime Delete (paired desktop, web, mobile, CLI) on the leftover of a delete that failed after
// Git dropped the registration: the leftover is listed with its error instead of vanishing from
// every listing; Delete refuses while the folder is there and finishes the rest once it is gone.
import { existsSync } from 'node:fs'
import { readFile, realpath, writeFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  join,
  listWorktreesStrict,
  mkdir,
  mkdtemp,
  removeWorktree,
  rm,
  scanLocalRepoWorktreesForResolutionMock,
  tmpdir
} from '../orca-runtime-test-mocks.spec'
import { TEST_REPO_ID, TEST_REPO_PATH } from '../orca-runtime-test-fixtures.spec'
import { createWorktreeRemovalRuntime } from '../orca-runtime-test-scenario-builders.spec'
import {
  _resetPendingWorktreeRemovalsForTests,
  _settlePendingWorktreeRemovalsForTests,
  loadWorktreeRemovalRecords,
  retryFailedWorktreeRemoval
} from '../../worktree-background-removal'
import {
  readWorktreeRemovalRecords,
  writeWorktreeRemovalRecords
} from '../../worktree-removal-records'

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

  it('lists the leftover with its error, though Git no longer does', async () => {
    const runtime = createWorktreeRemovalRuntime()

    const detected = await runtime.listDetectedManagedWorktrees(`id:${TEST_REPO_ID}`)

    expect(detected.worktrees.find((row) => row.id === leftoverId)).toMatchObject({
      path: leftover,
      removalError: FAILURE
    })
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
      ).rejects.toThrow(
        `Git no longer tracks ${leftover}, so Orca won't delete it. Remove the folder yourself, and Orca will drop this workspace from the list.`
      )
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

  it('ends the row once the user removed the folder', async () => {
    const runtime = createWorktreeRemovalRuntime()
    await rm(leftover, { recursive: true, force: true })

    const detected = await runtime.listDetectedManagedWorktrees(`id:${TEST_REPO_ID}`)

    expect(detected.worktrees.find((row) => row.id === leftoverId)).toBeUndefined()
    await vi.waitFor(async () => expect(await readWorktreeRemovalRecords(directory)).toEqual([]))
    expect(removeWorktree).not.toHaveBeenCalled()
  })

  it('takes the normal delete once Git registers a checkout at the path again', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    // A new checkout at the same path: the recorded choices were for the leftover, not for it.
    vi.mocked(listWorktreesStrict).mockResolvedValue([
      {
        path: leftover,
        head: 'def',
        branch: 'refs/heads/other',
        isBare: false,
        isMainWorktree: false
      }
    ])
    vi.mocked(removeWorktree).mockResolvedValue({})
    const runtime = createWorktreeRemovalRuntime()

    await runtime.removeManagedWorktree(`id:${leftoverId}`, { waitForBackgroundRemoval: true })
    await _settlePendingWorktreeRemovalsForTests()

    expect(removeWorktree).toHaveBeenCalledWith(TEST_REPO_PATH, leftover, false, expect.anything())
    expect(existsSync(join(leftover, 'node_modules'))).toBe(true)
    expect(await readWorktreeRemovalRecords(directory)).toEqual([])
  })

  it('joins a retry another client started while this Delete listed Git', async () => {
    const otherClientsRetry = vi.fn(async () => ({}))
    vi.mocked(listWorktreesStrict).mockImplementationOnce(async () => {
      void retryFailedWorktreeRemoval(leftoverId, 'local', () => ({
        run: otherClientsRetry,
        publish: () => {}
      }))
      return []
    })
    const runtime = createWorktreeRemovalRuntime()

    await expect(
      runtime.removeManagedWorktree(`id:${leftoverId}`, { waitForBackgroundRemoval: true })
    ).resolves.toEqual({})

    expect(otherClientsRetry).toHaveBeenCalledTimes(1)
    // Only the joined retry ran: the leftover is still there because its stub deleted nothing.
    expect(existsSync(join(leftover, 'node_modules'))).toBe(true)
    expect(removeWorktree).not.toHaveBeenCalled()
  })
})

describe('runtime listing straight after a delete fails partway', () => {
  let directory = ''
  let leftover = ''
  let leftoverId = ''

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    directory = await realpath(await mkdtemp(join(tmpdir(), 'orca-runtime-failed-listing-')))
    leftover = join(directory, 'feature')
    leftoverId = `${TEST_REPO_ID}::${leftover}`
    await mkdir(join(leftover, 'node_modules'), { recursive: true })
    await loadWorktreeRemovalRecords(directory)
  })

  afterEach(async () => {
    await _settlePendingWorktreeRemovalsForTests()
    _resetPendingWorktreeRemovalsForTests()
    vi.restoreAllMocks()
    await rm(directory, { recursive: true, force: true })
  })

  it('shows the failed row with its error, not the scan cached before the delete', async () => {
    const registered = {
      path: leftover,
      head: 'abc',
      branch: 'refs/heads/feature',
      isBare: false,
      isMainWorktree: false
    }
    const gitLists = (worktrees: (typeof registered)[]): void => {
      vi.mocked(listWorktreesStrict).mockResolvedValue(worktrees)
      scanLocalRepoWorktreesForResolutionMock.mockResolvedValue({ ok: true, worktrees })
    }
    gitLists([registered])
    const runtime = createWorktreeRemovalRuntime()
    const listLeftover = async () =>
      (await runtime.listDetectedManagedWorktrees(`id:${TEST_REPO_ID}`)).worktrees.find(
        (row) => row.id === leftoverId
      )
    // Caches Git's registration for the 30 s scan TTL.
    expect(await listLeftover()).not.toHaveProperty('removalError')
    vi.mocked(removeWorktree).mockImplementation(async () => {
      // Git drops the registration, then fails on a file it cannot delete.
      gitLists([])
      throw new Error(FAILURE)
    })

    await expect(
      runtime.removeManagedWorktree(`id:${leftoverId}`, {
        force: true,
        waitForBackgroundRemoval: true
      })
    ).rejects.toThrow(/Operation not permitted/)
    await _settlePendingWorktreeRemovalsForTests()

    expect(await listLeftover()).toMatchObject({
      path: leftover,
      removalError: expect.stringMatching(/Operation not permitted/)
    })
  })
})
