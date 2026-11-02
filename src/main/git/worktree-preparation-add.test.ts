import { beforeEach, expect, it, vi } from 'vitest'
import type * as FilePromises from 'node:fs/promises'
import type * as PreparationLock from './worktree-preparation-lock'
import { isUnsupportedWorktreeAddLockReasonError } from '../../shared/git-worktree-command-capabilities'

const mocks = vi.hoisted(() => ({
  git: vi.fn(),
  lstat: vi.fn(),
  lock: vi.fn(),
  verify: vi.fn(),
  discard: vi.fn()
}))
vi.mock('./runner', () => ({ gitExecFileAsync: mocks.git }))
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof FilePromises>()),
  lstat: mocks.lstat
}))
vi.mock('./worktree-preparation-lock', async (importOriginal) => ({
  ...(await importOriginal<typeof PreparationLock>()),
  lockWorktreePreparation: mocks.lock,
  verifyWorktreePreparationLock: mocks.verify
}))
vi.mock('./worktree-preparation-discard', () => ({ performDiscardPreparedWorktree: mocks.discard }))

import { addLockedWorktreePreparation } from './worktree-preparation-add'
import { clearGitCapabilityStateForTests, getLocalGitCapabilityCache } from './git-capability-state'
import { WorktreePreparationLockOwnershipError } from './worktree-preparation-lock'
import { WORKTREE_REMOVAL_REGISTRATION_TIMEOUT_MS } from './worktree-operation-options'
import {
  resetWslLinkedWorktreeGitRoutingForTests,
  seedWslLinkedWorktreeGitRoutingForTests
} from './wsl-linked-worktree-git-routing'

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

it('asks Git to create the exact marker atomically and only verifies its ownership', async () => {
  const controller = new AbortController()
  const options = { signal: controller.signal, timeout: 6000, admissionTier: 'background' as const }
  await expect(prepare('/prepared', options)).resolves.toBe('/atomic-lock')
  expect(mocks.git).toHaveBeenCalledExactlyOnceWith(
    [
      'worktree',
      'add',
      '--detach',
      '--no-checkout',
      '--lock',
      '--reason',
      reason,
      '/prepared',
      'refs/heads/main'
    ],
    { cwd: '/repo', ...options }
  )
  expect(mocks.verify).toHaveBeenCalledExactlyOnceWith('/prepared', reason, options)
  expect(mocks.lock).not.toHaveBeenCalled()
})

it('falls back once on the old-Git reason rejection and caches the absence', async () => {
  mocks.git.mockRejectedValueOnce(unsupported)
  await expect(prepare()).resolves.toBe('/fallback-lock')
  await expect(prepare('/second')).resolves.toBe('/fallback-lock')
  expect(mocks.git.mock.calls.map(([args]) => args.includes('--reason'))).toEqual([
    true,
    false,
    false
  ])
  expect(mocks.lock.mock.calls.map(([path]) => path)).toEqual(['/prepared', '/second'])
  expect(mocks.verify).not.toHaveBeenCalled()
  expect(mocks.discard).not.toHaveBeenCalled()
})

it.each([
  ['first', 'cancellation'],
  ['cached', 'cancellation'],
  ['first', 'path probe'],
  ['cached', 'path probe'],
  ['first', 'marker write'],
  ['cached', 'marker write']
])('cleans its successful %s fallback add after a %s failure', async (fallback, failureKind) => {
  const controller = new AbortController()
  const options = {
    signal: controller.signal,
    timeout: 180_000,
    wslDistro: 'Ubuntu',
    admissionTier: 'background' as const
  }
  if (fallback === 'cached') {
    getLocalGitCapabilityCache(options).rememberUnsupported('worktree-add-lock-reason')
  } else {
    mocks.git.mockRejectedValueOnce(unsupported)
  }
  const failure = new Error(`${failureKind} failed after registration`)
  mocks.lock.mockImplementationOnce(async () => {
    if (failureKind === 'cancellation') {
      controller.abort(failure)
    }
    throw failure
  })
  await expect(prepare('/prepared', options)).rejects.toBe(failure)
  expect(mocks.discard).toHaveBeenCalledExactlyOnceWith('/repo', '/prepared', {
    ...options,
    signal: undefined,
    timeout: WORKTREE_REMOVAL_REGISTRATION_TIMEOUT_MS
  })
  expect(mocks.lstat).toHaveBeenCalled()
  expect(options.timeout).toBe(180_000)
  expect(options.signal).toBe(controller.signal)
})

it('preserves the original lock failure when bounded fallback cleanup also fails', async () => {
  getLocalGitCapabilityCache().rememberUnsupported('worktree-add-lock-reason')
  const failure = new Error('lock path unavailable')
  mocks.lock.mockRejectedValueOnce(failure)
  mocks.discard.mockRejectedValueOnce(new Error('cleanup unavailable'))
  await expect(prepare()).rejects.toBe(failure)
  expect(mocks.discard).toHaveBeenCalledOnce()
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

it('isolates native rejection from individual WSL distros', async () => {
  mocks.git.mockRejectedValueOnce(unsupported)
  await prepare()
  await prepare('/ubuntu', { wslDistro: 'Ubuntu' })
  await prepare('/debian', { wslDistro: 'Debian' })
  await prepare('/native-again')
  expect(mocks.git.mock.calls.map(([args]) => args.includes('--reason'))).toEqual([
    true,
    false,
    true,
    true,
    false
  ])
})

it('uses native cached rejection when WSL routing executes the host Git binary', async () => {
  getLocalGitCapabilityCache().rememberUnsupported('worktree-add-lock-reason')
  const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  try {
    const repoPath = String.raw`C:\repo\linked`
    seedWslLinkedWorktreeGitRoutingForTests(repoPath)
    await addLockedWorktreePreparation(repoPath, String.raw`C:\prepared`, 'main', reason, {
      wslDistro: 'Ubuntu'
    })
    expect(mocks.git).toHaveBeenCalledTimes(1)
    expect(mocks.git.mock.calls[0][0]).not.toContain('--reason')
    expect(
      getLocalGitCapabilityCache({ wslDistro: 'Ubuntu' }).shouldTry('worktree-add-lock-reason')
    ).toBe(true)
  } finally {
    platform.mockRestore()
  }
})

it('checks a guest directory through its execution distro rather than the Windows root', async () => {
  const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  try {
    await prepare('/home/prepared', { wslDistro: 'Ubuntu' })
    expect(mocks.lstat).toHaveBeenCalledExactlyOnceWith(
      String.raw`\\wsl.localhost\Ubuntu\home\prepared`
    )
  } finally {
    platform.mockRestore()
  }
})

it('fails closed when the pre-existing target cannot be inspected', async () => {
  const failure = Object.assign(new Error('path access denied'), { code: 'EACCES' })
  mocks.lstat.mockRejectedValueOnce(failure)
  await expect(prepare()).rejects.toBe(failure)
  expect(mocks.git).not.toHaveBeenCalled()
  expect(mocks.discard).not.toHaveBeenCalled()
})

it('keeps a general add failure visible without poisoning the capability or claiming a marker', async () => {
  const failure = new Error('permission denied')
  mocks.git.mockRejectedValueOnce(failure)
  await expect(prepare()).rejects.toBe(failure)
  expect(mocks.lock).not.toHaveBeenCalled()
  expect(getLocalGitCapabilityCache().shouldTry('worktree-add-lock-reason')).toBe(true)
  expect(mocks.discard).toHaveBeenCalledExactlyOnceWith('/repo', '/prepared', {}, reason)
  await prepare('/next')
  expect(mocks.git.mock.calls.every(([args]) => args.includes('--reason'))).toBe(true)
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

it('attempts ownership-checked cleanup if cancellation interrupts the newly registered add', async () => {
  const controller = new AbortController()
  const failure = new Error('add canceled')
  mocks.git.mockImplementationOnce(async () => {
    controller.abort()
    throw failure
  })
  const options = { signal: controller.signal }
  await expect(prepare('/prepared', options)).rejects.toBe(failure)
  expect(mocks.discard).toHaveBeenCalledExactlyOnceWith('/repo', '/prepared', options, reason)
  expect(mocks.lock).not.toHaveBeenCalled()
})

it.each([
  [new Error("unknown option 'reason'"), true],
  [{ stderr: "error: unrecognized option '--reason'" }, true],
  [{ stdout: 'invalid switch --reason' }, true],
  [{ code: 129, stderr: "unknown option 'detach'" }, false],
  [{ code: 129 }, false],
  [new Error('permission denied while writing lock reason'), false]
])('recognizes only an unsupported lock-reason option: %j', (error, expected) => {
  expect(isUnsupportedWorktreeAddLockReasonError(error)).toBe(expected)
})
