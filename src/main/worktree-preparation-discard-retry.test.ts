import { mocks, repo, store, flushBackgroundWork } from './__mocks__/worktree-create-preparation'
import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../shared/repo-types'
import {
  _resetWorktreeCreatePreparationsForTests,
  prepareWorktreeCreateForRepo
} from './worktree-create-preparation'

describe('worktree preparation discard retries', () => {
  it('retries a discard that failed while this process is still alive', async () => {
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    const leakedPath = mocks.prepareCheckout.mock.calls[0][1] as string
    mocks.discard.mockRejectedValueOnce(new Error('EBUSY'))

    // Fill the registry so the first preparation is evicted while its owner pid is still alive.
    for (const base of ['origin/one', 'origin/two', 'origin/three']) {
      await prepareWorktreeCreateForRepo(store, repo, base)
    }
    await flushBackgroundWork()
    expect(mocks.discard).toHaveBeenCalledWith(repo.path, leakedPath, {}, expect.any(String))

    mocks.discard.mockClear()
    await prepareWorktreeCreateForRepo(store, repo, 'origin/four')
    await flushBackgroundWork()
    expect(mocks.discard).toHaveBeenCalledWith(repo.path, leakedPath, {}, expect.any(String))

    mocks.discard.mockClear()
    await prepareWorktreeCreateForRepo(store, repo, 'origin/five')
    await flushBackgroundWork()
    expect(mocks.discard).not.toHaveBeenCalledWith(repo.path, leakedPath, {}, expect.any(String))
  })

  it('retries only the leaked paths belonging to the host being prepared', async () => {
    const otherRepo = { ...repo, id: 'repo-2', path: '/other-repo' } as Repo
    const unremovable = new Set<string>()
    mocks.discard.mockImplementation(async (_repoPath: string, path: string) => {
      if (unremovable.has(path)) {
        throw new Error('EBUSY')
      }
    })

    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    const leakedHere = mocks.prepareCheckout.mock.calls[0][1] as string
    await prepareWorktreeCreateForRepo(store, otherRepo, 'origin/main')
    const leakedElsewhere = mocks.prepareCheckout.mock.calls[1][1] as string
    unremovable.add(leakedHere)
    unremovable.add(leakedElsewhere)

    // Evict through each host's own arming: eviction prefers the incoming workspace's oldest
    // entry, so preparing for `repo` no longer reaches across and takes `otherRepo`'s.
    for (const base of ['origin/one', 'origin/two']) {
      await prepareWorktreeCreateForRepo(store, repo, base)
    }
    for (const base of ['origin/one', 'origin/two']) {
      await prepareWorktreeCreateForRepo(store, otherRepo, base)
    }
    await flushBackgroundWork()
    expect(mocks.discard).toHaveBeenCalledWith(repo.path, leakedHere, {}, expect.any(String))
    expect(mocks.discard).toHaveBeenCalledWith(
      otherRepo.path,
      leakedElsewhere,
      {},
      expect.any(String)
    )

    mocks.discard.mockClear()
    await prepareWorktreeCreateForRepo(store, repo, 'origin/four')
    await flushBackgroundWork()
    expect(mocks.discard).toHaveBeenCalledWith(repo.path, leakedHere, {}, expect.any(String))
    expect(mocks.discard.mock.calls.some((call) => call[1] === leakedElsewhere)).toBe(false)
  })

  it('stops retrying a preparation that never becomes removable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await prepareWorktreeCreateForRepo(store, repo, 'origin/main')
      const leakedPath = mocks.prepareCheckout.mock.calls[0][1] as string
      mocks.discard.mockImplementation(async (_repoPath: string, path: string) => {
        if (path === leakedPath) {
          throw new Error('EBUSY')
        }
      })
      const leakedDiscards = (): number =>
        mocks.discard.mock.calls.filter((call) => call[1] === leakedPath).length

      for (const base of ['origin/one', 'origin/two', 'origin/three']) {
        await prepareWorktreeCreateForRepo(store, repo, base)
      }
      await flushBackgroundWork()
      expect(leakedDiscards()).toBe(1)

      for (const base of ['origin/four', 'origin/five', 'origin/six']) {
        await prepareWorktreeCreateForRepo(store, repo, base)
        await flushBackgroundWork()
      }
      expect(leakedDiscards()).toBe(3)
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(`could not be discarded in 3 attempts; ${leakedPath}`),
        expect.any(Error)
      )
    } finally {
      warn.mockRestore()
    }
  })

  it('retries a failed checkout whose own self-discard also left the path registered', async () => {
    let failCheckout!: (error: Error) => void
    mocks.prepareCheckout.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          failCheckout = reject
        })
    )
    const failing = prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    await flushBackgroundWork()
    const leakedPath = mocks.prepareCheckout.mock.calls[0][1] as string

    // Evict it while its checkout is still in flight, so discardEntry runs on a failed preparation.
    for (const base of ['origin/one', 'origin/two', 'origin/three']) {
      await prepareWorktreeCreateForRepo(store, repo, base)
    }
    mocks.discard.mockRejectedValueOnce(new Error('EBUSY'))
    failCheckout(new Error('worktree add failed'))
    await failing.catch(() => {})
    await flushBackgroundWork()
    expect(mocks.discard).toHaveBeenCalledWith(repo.path, leakedPath, {}, expect.any(String))

    mocks.discard.mockClear()
    await prepareWorktreeCreateForRepo(store, repo, 'origin/four')
    await flushBackgroundWork()
    expect(mocks.discard).toHaveBeenCalledWith(repo.path, leakedPath, {}, expect.any(String))
  })

  it('scopes retries to the WSL distro whose preparation leaked', async () => {
    const unremovable = new Set<string>()
    mocks.discard.mockImplementation(async (_repoPath: string, path: string) => {
      if (unremovable.has(path)) {
        throw new Error('EBUSY')
      }
    })

    mocks.getWorktreeOptions.mockReturnValue({ wslDistro: 'Ubuntu' })
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    const leakedOnUbuntu = mocks.prepareCheckout.mock.calls[0][1] as string
    mocks.getWorktreeOptions.mockReturnValue({ wslDistro: 'Debian' })
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    const leakedOnDebian = mocks.prepareCheckout.mock.calls[1][1] as string
    unremovable.add(leakedOnUbuntu)
    unremovable.add(leakedOnDebian)

    // Evict through each distro's own arming: the eviction scope includes the distro, so arming
    // under Ubuntu no longer reaches across and takes the Debian entry.
    mocks.getWorktreeOptions.mockReturnValue({ wslDistro: 'Ubuntu' })
    for (const base of ['origin/one', 'origin/two']) {
      await prepareWorktreeCreateForRepo(store, repo, base)
    }
    mocks.getWorktreeOptions.mockReturnValue({ wslDistro: 'Debian' })
    await prepareWorktreeCreateForRepo(store, repo, 'origin/one')
    mocks.getWorktreeOptions.mockReturnValue({ wslDistro: 'Ubuntu' })
    await flushBackgroundWork()
    expect(mocks.discard).toHaveBeenCalledWith(
      repo.path,
      leakedOnUbuntu,
      { wslDistro: 'Ubuntu' },
      expect.any(String)
    )
    expect(mocks.discard).toHaveBeenCalledWith(
      repo.path,
      leakedOnDebian,
      { wslDistro: 'Debian' },
      expect.any(String)
    )

    mocks.discard.mockClear()
    await prepareWorktreeCreateForRepo(store, repo, 'origin/four')
    await flushBackgroundWork()
    expect(mocks.discard).toHaveBeenCalledWith(
      repo.path,
      leakedOnUbuntu,
      { wslDistro: 'Ubuntu' },
      expect.any(String)
    )
    expect(mocks.discard.mock.calls.some((call) => call[1] === leakedOnDebian)).toBe(false)
  })

  it('drops recorded discards when the registry is reset for tests', async () => {
    await prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    const leakedPath = mocks.prepareCheckout.mock.calls[0][1] as string
    // Reject on a real timer so the fire-and-forget discard is still in flight at reset.
    mocks.discard.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      throw new Error('EBUSY')
    })

    for (const base of ['origin/one', 'origin/two', 'origin/three']) {
      await prepareWorktreeCreateForRepo(store, repo, base)
    }
    await _resetWorktreeCreatePreparationsForTests()
    // Past the rejection timer: the reset must have absorbed the failure, not raced ahead of it.
    await flushBackgroundWork(20)

    mocks.discard.mockClear()
    await prepareWorktreeCreateForRepo(store, repo, 'origin/four')
    await flushBackgroundWork()
    expect(mocks.discard).not.toHaveBeenCalledWith(repo.path, leakedPath, {}, expect.any(String))
  })

  it("settles an evicted preparation's discard before the reset drops the registry", async () => {
    let failCheckout!: (error: Error) => void
    mocks.prepareCheckout.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          failCheckout = reject
        })
    )
    const failing = prepareWorktreeCreateForRepo(store, repo, 'origin/main')
    await flushBackgroundWork()
    const leakedPath = mocks.prepareCheckout.mock.calls[0][1] as string
    mocks.discard.mockImplementation(async (_repoPath: string, path: string) => {
      if (path === leakedPath) {
        throw new Error('EBUSY')
      }
    })

    for (const base of ['origin/one', 'origin/two', 'origin/three']) {
      await prepareWorktreeCreateForRepo(store, repo, base)
    }
    // The eviction's discard is still parked on the checkout, so the reset has to wait for it.
    const reset = _resetWorktreeCreatePreparationsForTests()
    await flushBackgroundWork(5)
    failCheckout(new Error('worktree add failed'))
    await failing.catch(() => {})
    await reset
    await flushBackgroundWork(5)

    mocks.discard.mockClear()
    await prepareWorktreeCreateForRepo(store, repo, 'origin/four')
    await flushBackgroundWork()
    expect(mocks.discard).not.toHaveBeenCalledWith(repo.path, leakedPath, {}, expect.any(String))
  })
})
