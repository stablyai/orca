import { beforeEach, expect, it, vi } from 'vitest'
import type * as FilePromises from 'node:fs/promises'
import type * as PreparationLock from './worktree-preparation-lock'

const mocks = vi.hoisted(() => ({
  git: vi.fn(),
  lstat: vi.fn(),
  lock: vi.fn(),
  verify: vi.fn(),
  discard: vi.fn()
}))
vi.mock('../../command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileAsync: mocks.git
}))
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof FilePromises>()),
  lstat: mocks.lstat
}))
vi.mock('./worktree-preparation-lock', async (importOriginal) => ({
  ...(await importOriginal<typeof PreparationLock>()),
  lockWorktreePreparation: mocks.lock,
  verifyWorktreePreparationLock: mocks.verify
}))
vi.mock('./worktree-preparation-discard', () => ({ discardPreparedWorktree: mocks.discard }))

import { addLockedWorktreePreparation } from './worktree-preparation-add'
import {
  clearGitCapabilityStateForTests,
  getLocalGitCapabilityCache
} from '../../command-runner/host-routing/git-capability-state'
import { WorktreePreparationLockOwnershipError } from './worktree-preparation-lock'
import { resetWslLinkedWorktreeGitRoutingForTests } from '../../command-runner/host-routing/wsl-linked-worktree-git-routing'

const reason = 'orca-create-preparation:v1:123:atomic'
const unsupported = Object.assign(new Error("error: unknown option 'reason'"), { code: 129 })
const prepare = (path = '/prepared', options = {}) =>
  addLockedWorktreePreparation('/repo', path, 'refs/heads/main', reason, options)

beforeEach(() => {
  clearGitCapabilityStateForTests()
  resetWslLinkedWorktreeGitRoutingForTests()
  mocks.git.mockReset().mockResolvedValue({ stdout: '', stderr: '' })
  mocks.lstat.mockReset().mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
  mocks.lock.mockReset().mockResolvedValue('/fallback-lock')
  mocks.verify.mockReset().mockResolvedValue('/atomic-lock')
  mocks.discard.mockReset().mockResolvedValue(undefined)
})

it.each(['first', 'cached'])(
  'preserves a pre-existing target after %s fallback locking fails',
  async (fallback) => {
    if (fallback === 'cached') {
      getLocalGitCapabilityCache().rememberUnsupported('worktree-add-lock-reason')
    } else {
      mocks.git.mockRejectedValueOnce(unsupported)
    }
    mocks.lstat.mockResolvedValue({})
    const failure = new Error('marker write denied')
    mocks.lock.mockRejectedValueOnce(failure)
    await expect(prepare()).rejects.toBe(failure)
    expect(mocks.discard).not.toHaveBeenCalled()
  }
)

it.each(['first', 'cached'])(
  'preserves a competing marker during %s fallback locking',
  async (fallback) => {
    if (fallback === 'cached') {
      getLocalGitCapabilityCache().rememberUnsupported('worktree-add-lock-reason')
    } else {
      mocks.git.mockRejectedValueOnce(unsupported)
    }
    mocks.lock.mockRejectedValueOnce(new WorktreePreparationLockOwnershipError())
    await expect(prepare()).rejects.toThrow('lock owner changed')
    expect(mocks.discard).not.toHaveBeenCalled()
  }
)

it.each(['first', 'cached'])(
  'preserves an incomplete or rejected %s fallback add',
  async (fallback) => {
    if (fallback === 'cached') {
      getLocalGitCapabilityCache().rememberUnsupported('worktree-add-lock-reason')
    } else {
      mocks.git.mockRejectedValueOnce(unsupported)
    }
    const failure = new Error('add did not complete')
    mocks.git.mockRejectedValueOnce(failure)
    await expect(prepare()).rejects.toBe(failure)
    expect(mocks.lock).not.toHaveBeenCalled()
    expect(mocks.discard).not.toHaveBeenCalled()
  }
)

it('fails closed before a cached fallback add if the target cannot be inspected', async () => {
  getLocalGitCapabilityCache().rememberUnsupported('worktree-add-lock-reason')
  const failure = Object.assign(new Error('target unavailable'), { code: 'EACCES' })
  mocks.lstat.mockRejectedValueOnce(failure)
  await expect(prepare()).rejects.toBe(failure)
  expect(mocks.git).not.toHaveBeenCalled()
  expect(mocks.lock).not.toHaveBeenCalled()
  expect(mocks.discard).not.toHaveBeenCalled()
})

it('coalesces concurrent unsupported probes while creating each checkout separately', async () => {
  let reject!: (error: unknown) => void
  mocks.git.mockImplementationOnce(
    () =>
      new Promise((_resolve, rejectProbe) => {
        reject = rejectProbe
      })
  )
  const first = prepare('/first')
  await vi.waitFor(() => expect(mocks.git).toHaveBeenCalledTimes(1))
  const second = prepare('/second')
  await Promise.resolve()
  expect(mocks.git).toHaveBeenCalledTimes(1)
  reject(unsupported)
  await expect(Promise.all([first, second])).resolves.toEqual(['/fallback-lock', '/fallback-lock'])
  expect(mocks.git.mock.calls.filter(([args]) => args.includes('--reason'))).toHaveLength(1)
  expect(new Set(mocks.lock.mock.calls.map(([path]) => path))).toEqual(
    new Set(['/first', '/second'])
  )
})

it('runs each concurrent supported add rather than sharing the first checkout result', async () => {
  let resolve!: (value: { stdout: string }) => void
  mocks.git.mockImplementationOnce(
    () =>
      new Promise((resolveProbe) => {
        resolve = resolveProbe
      })
  )
  mocks.verify.mockImplementation(async (path: string) => `${path}/owned-lock`)
  const first = prepare('/first')
  await vi.waitFor(() => expect(mocks.git).toHaveBeenCalledTimes(1))
  const second = prepare('/second')
  resolve({ stdout: '' })
  await expect(Promise.all([first, second])).resolves.toEqual([
    '/first/owned-lock',
    '/second/owned-lock'
  ])
  expect(mocks.git.mock.calls.every(([args]) => args.includes('--reason'))).toBe(true)
  expect(mocks.git).toHaveBeenCalledTimes(2)
})

it('fails closed when the pre-existing target cannot be inspected', async () => {
  const failure = Object.assign(new Error('path access denied'), { code: 'EACCES' })
  mocks.lstat.mockRejectedValueOnce(failure)
  await expect(prepare()).rejects.toBe(failure)
  expect(mocks.git).not.toHaveBeenCalled()
  expect(mocks.discard).not.toHaveBeenCalled()
})

it('never removes a pre-existing checkout after add fails', async () => {
  mocks.lstat.mockResolvedValueOnce({})
  mocks.git.mockRejectedValueOnce(new Error('path already exists'))
  await expect(prepare()).rejects.toThrow('path already exists')
  expect(mocks.discard).not.toHaveBeenCalled()
  expect(mocks.lock).not.toHaveBeenCalled()
})

it('does not rewrite or discard a generic or competing marker returned after add', async () => {
  mocks.verify.mockRejectedValueOnce(new WorktreePreparationLockOwnershipError())
  await expect(prepare()).rejects.toThrow('lock owner changed')
  expect(mocks.lock).not.toHaveBeenCalled()
  expect(mocks.discard).not.toHaveBeenCalled()
})
