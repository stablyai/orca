import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  throwIfSignalAborted,
  waitForPromiseWithSignal
} from '../../../../shared/abort-signal-reason'
import type { GitWorktreeInfo } from '../../../../shared/worktree/types'

const { graph, stat, names, removeChild, unlink, rmdir, clean } = vi.hoisted(() => ({
  graph: vi.fn(),
  stat: vi.fn(),
  names: vi.fn(),
  removeChild: vi.fn(),
  unlink: vi.fn(),
  rmdir: vi.fn(),
  clean: vi.fn()
}))
vi.mock('../catalog/worktree-list-reader', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  readTranslatedWorktreeGraph: graph
}))
vi.mock('../../../filesystem/asar-transparent-fs', () => ({
  lstat: stat,
  readdir: names,
  rm: removeChild,
  unlink,
  rmdir
}))
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  readFile: async () => 'gitdir: C:/repo/.git/worktrees/feature'
}))
vi.mock('../../../workspaces/removal/worktree-removal-safety', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  canSafelyRemoveOrphanedWorktreeDirectory: async () => true
}))
vi.mock('./worktree-removal-preflight', () => ({ assertWorktreeCleanForRemoval: clean }))

import { authorizeWindowsCheckout, removeWindowsCheckout } from './windows-worktree-removal'
import { _resetWorktreeScanCacheForTests } from '../catalog/worktree-scan-cache'

const originalPlatform = process.platform
const root = 'C:/checkout/feature'
const row: GitWorktreeInfo = {
  path: root,
  branch: 'refs/heads/feature',
  head: 'abc',
  isBare: false,
  isMainWorktree: false
}
const missing = Object.assign(new Error('missing'), { code: 'ENOENT' })

beforeEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  _resetWorktreeScanCacheForTests()
  graph.mockResolvedValue([row])
  stat.mockImplementation(async (path: string) => {
    if (String(path).endsWith('locked')) {
      throw missing
    }
    return { isDirectory: () => true, isSymbolicLink: () => false }
  })
  names.mockResolvedValue(['held', '.git'])
  removeChild.mockResolvedValue(undefined)
  unlink.mockResolvedValue(undefined)
  rmdir.mockResolvedValue(undefined)
  clean.mockResolvedValue(undefined)
})
afterEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
  vi.resetAllMocks()
  _resetWorktreeScanCacheForTests()
})

it.each([10, 100])(
  'shares one native eligibility graph for %i equivalent overlapping authorizations',
  async (population) => {
    const reading = Promise.withResolvers<GitWorktreeInfo[]>()
    graph.mockReturnValueOnce(reading.promise)
    const signal = new AbortController().signal
    const checks = Array.from({ length: population }, () =>
      authorizeWindowsCheckout('C:/repo', root, true, { checkoutDeleteSignal: signal })
    )
    expect(graph).toHaveBeenCalledOnce()
    reading.resolve([row])
    expect(await Promise.all(checks)).toEqual(Array.from({ length: population }, () => true))
    expect(graph.mock.calls[0]?.[1].signal).toBe(signal)
  }
)

it('refuses nested preparation registrations and strict inventory errors', async () => {
  graph.mockResolvedValueOnce([row, { ...row, path: `${root}/.orca-worktree-preparation` }])
  await expect(authorizeWindowsCheckout('C:/repo', root, true, {})).rejects.toThrow(
    'another registered worktree'
  )
  const failure = new Error('inventory failed')
  graph.mockRejectedValueOnce(failure)
  await expect(authorizeWindowsCheckout('C:/repo', root, true, {})).rejects.toBe(failure)
  expect(removeChild).not.toHaveBeenCalled()
})

it.each(['status', 'recursive'] as const)(
  'cancels the later %s read with the original checkout stop reason',
  async (stage) => {
    const controller = new AbortController()
    const held = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    if (stage === 'status') {
      clean.mockImplementation(async (_root, _force, options) => {
        entered.resolve()
        await waitForPromiseWithSignal(held.promise, options.signal)
      })
    } else {
      graph
        .mockImplementationOnce(async () => [row])
        .mockImplementationOnce(async (_repo, options) => {
          entered.resolve()
          await waitForPromiseWithSignal(held.promise, options.signal)
          return [row]
        })
    }
    const reason = new Error('owner stopped')
    const pending = authorizeWindowsCheckout('C:/repo', root, false, {
      checkoutDeleteSignal: controller.signal
    })
    const rejected = expect(pending).rejects.toBe(reason)
    await entered.promise
    controller.abort(reason)
    await rejected
    expect(unlink).not.toHaveBeenCalled()
  }
)

it('joins held children before cancelling the real repeated delete-time authorization', async () => {
  const controller = new AbortController()
  const sibling = Promise.withResolvers<void>()
  const childrenStarted = Promise.withResolvers<void>()
  const repeated = Promise.withResolvers<void>()
  let settled = false
  removeChild.mockImplementation(async () => {
    childrenStarted.resolve()
    await sibling.promise
  })
  // Initial clean authorization and its recursive proof, then the post-child recheck.
  graph
    .mockImplementationOnce(async () => [row])
    .mockImplementationOnce(async () => [row])
    .mockImplementationOnce(async (_repo, options) => {
      repeated.resolve()
      await waitForPromiseWithSignal(new Promise<never>(() => {}), options.signal)
      throwIfSignalAborted(options.signal)
      return [row]
    })
  const pending = removeWindowsCheckout('C:/repo', root, false, {
    checkoutDeleteSignal: controller.signal
  })
  const outcome = pending
    .finally(() => {
      settled = true
    })
    .catch((error: unknown) => error)
  await childrenStarted.promise
  expect(settled).toBe(false)
  expect(unlink).not.toHaveBeenCalled()
  sibling.resolve()
  await repeated.promise
  const reason = new Error('owner stopped during repeated proof')
  controller.abort(reason)
  expect(await outcome).toBe(reason)
  expect(unlink).not.toHaveBeenCalled()
  expect(rmdir).not.toHaveBeenCalled()
})

it('honors distinct read and checkout signals without replacing either caller option', async () => {
  const read = new AbortController()
  const checkout = new AbortController()
  const entered = Promise.withResolvers<void>()
  graph.mockImplementation(async (_repo, options) => {
    entered.resolve()
    return waitForPromiseWithSignal(new Promise<GitWorktreeInfo[]>(() => {}), options.signal)
  })
  const options = { signal: read.signal, checkoutDeleteSignal: checkout.signal }
  const reason = new Error('checkout closing')
  const rejected = expect(authorizeWindowsCheckout('C:/repo', root, true, options)).rejects.toBe(
    reason
  )
  await entered.promise
  checkout.abort(reason)
  await rejected
  expect(options.signal).toBe(read.signal)
  expect(options.checkoutDeleteSignal).toBe(checkout.signal)
})
