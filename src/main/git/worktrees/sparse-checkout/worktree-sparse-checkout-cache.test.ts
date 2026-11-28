import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as SparseStateModule from './worktree-sparse-state'

vi.mock('./worktree-sparse-state', async (importOriginal) => {
  const original = await importOriginal<typeof SparseStateModule>()
  return { ...original, detectSparseCheckout: vi.fn(original.detectSparseCheckout) }
})

import { detectSparseCheckout } from './worktree-sparse-state'
import {
  __resetSparseCheckoutStateCacheForTests,
  clearSparseCheckoutStateCache,
  clearSparseCheckoutStateCacheForRepo,
  detectSparseCheckoutCached,
  invalidateSparseCheckoutState,
  onSparseCheckoutStateChanged,
  retainSparseCheckoutWorkingSet
} from './worktree-sparse-checkout-cache'

const probe = vi.mocked(detectSparseCheckout)
const actualSparseState = await vi.importActual<typeof SparseStateModule>('./worktree-sparse-state')
let root: string
let worktree: string

function deferredProbe() {
  let resolve!: (value: boolean) => void
  let reject!: (error: Error) => void
  const promise = new Promise<boolean>((accept, fail) => {
    resolve = accept
    reject = fail
  })
  return { promise, resolve, reject }
}

async function enableSparse(): Promise<void> {
  await writeFile(join(worktree, '.git', 'config'), '[core]\n sparseCheckout = true\n')
}

beforeEach(async () => {
  __resetSparseCheckoutStateCacheForTests()
  probe.mockReset()
  probe.mockImplementation(actualSparseState.detectSparseCheckout)
  root = await mkdtemp(join(tmpdir(), 'orca-sparse-cache-'))
  worktree = join(root, 'checkout')
  await mkdir(join(worktree, '.git', 'info'), { recursive: true })
  await writeFile(join(worktree, '.git', 'info', 'sparse-checkout'), '/*\n')
  vi.useFakeTimers({ toFake: ['Date'] })
})

afterEach(async () => {
  clearSparseCheckoutStateCache()
  vi.useRealTimers()
  await rm(root, { recursive: true, force: true })
})

describe('sparse checkout cache authority', () => {
  it('limits background probes and eventually revalidates every stale checkout', async () => {
    const paths = Array.from({ length: 20 }, (_, index) => join(root, `tree-${index}`))
    probe.mockResolvedValue(false)
    retainSparseCheckoutWorkingSet(root, paths)
    await Promise.all(paths.map((path) => detectSparseCheckoutCached(root, path)))
    vi.advanceTimersByTime(300_000)
    const held = deferredProbe()
    probe.mockClear().mockReturnValue(held.promise)
    await Promise.all(paths.map((path) => detectSparseCheckoutCached(root, path)))
    expect(probe).toHaveBeenCalledTimes(8)
    held.resolve(true)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(probe).toHaveBeenCalledTimes(20)
    expect(await detectSparseCheckoutCached(root, paths[19])).toBe(true)
  })

  it('bounds incidental answers even when most listed paths have not been probed', async () => {
    probe.mockResolvedValue(false)
    retainSparseCheckoutWorkingSet(root, [
      worktree,
      ...Array.from({ length: 1491 }, (_, index) => `${worktree}-${index}`)
    ])
    expect(await detectSparseCheckoutCached(root, worktree)).toBe(false)
    for (let index = 0; index < 512; index += 1) {
      await detectSparseCheckoutCached(root, join(root, `incidental-${index}`))
    }
    probe.mockResolvedValue(true)
    expect(await detectSparseCheckoutCached(root, join(root, 'incidental-overflow'))).toBe(true)

    expect(await detectSparseCheckoutCached(root, join(root, 'incidental-0'))).toBe(true)
    expect(await detectSparseCheckoutCached(root, worktree)).toBe(false)
  })

  it.skipIf(process.platform !== 'darwin')(
    'retains the same answer through macOS temporary path aliases',
    async () => {
      probe.mockResolvedValueOnce(false).mockResolvedValue(true)
      retainSparseCheckoutWorkingSet(root, ['/private/tmp/orca-checkout'])
      expect(await detectSparseCheckoutCached(root, '/tmp/orca-checkout')).toBe(false)
      retainSparseCheckoutWorkingSet(root, ['/private/tmp/orca-checkout'])

      expect(await detectSparseCheckoutCached(root, '/private/tmp/orca-checkout')).toBe(false)
    }
  )

  it('reconciles a cached negative from the filesystem after five minutes and publishes the flip', async () => {
    expect(await detectSparseCheckoutCached(root, worktree)).toBe(false)
    await enableSparse()
    expect(await detectSparseCheckoutCached(root, worktree)).toBe(false)
    vi.advanceTimersByTime(300_000)
    const changed = new Promise<unknown[]>((resolve) => {
      onSparseCheckoutStateChanged((...args) => resolve(args))
    })

    expect(await detectSparseCheckoutCached(root, worktree)).toBe(false)
    expect(await changed).toEqual([root, worktree, true])
    expect(await detectSparseCheckoutCached(root, worktree)).toBe(true)
  })

  it('invalidates every distro for a repo without clearing another registration of the same root', async () => {
    await detectSparseCheckoutCached(root, worktree, { wslDistro: 'Ubuntu' })
    await detectSparseCheckoutCached(root, worktree)
    await detectSparseCheckoutCached(`${root}/other-repo`, worktree)
    await enableSparse()
    invalidateSparseCheckoutState(root, worktree)

    expect(await detectSparseCheckoutCached(root, worktree, { wslDistro: 'Ubuntu' })).toBe(true)
    expect(await detectSparseCheckoutCached(root, worktree)).toBe(true)
    expect(await detectSparseCheckoutCached(`${root}/other-repo`, worktree)).toBe(false)
    clearSparseCheckoutStateCacheForRepo(`${root}/other-repo`)
    expect(await detectSparseCheckoutCached(`${root}/other-repo`, worktree)).toBe(true)
  })

  it('retires removed working-set paths so reintroduced checkouts are probed again', async () => {
    retainSparseCheckoutWorkingSet(root, [worktree])
    expect(await detectSparseCheckoutCached(root, worktree)).toBe(false)
    retainSparseCheckoutWorkingSet(root, [])
    await enableSparse()
    retainSparseCheckoutWorkingSet(root, [worktree])

    expect(await detectSparseCheckoutCached(root, worktree)).toBe(true)
  })

  it('does not let a cold probe repopulate an invalidated checkout', async () => {
    const held = deferredProbe()
    probe.mockReturnValueOnce(held.promise).mockResolvedValueOnce(true)
    const old = detectSparseCheckoutCached(root, worktree)
    invalidateSparseCheckoutState(root, worktree)
    expect(await detectSparseCheckoutCached(root, worktree)).toBe(true)
    held.resolve(false)
    expect(await old).toBe(false)

    expect(await detectSparseCheckoutCached(root, worktree)).toBe(true)
  })

  it('fences late cold probes when a repo is cleaned up', async () => {
    const held = deferredProbe()
    probe.mockReturnValueOnce(held.promise).mockResolvedValueOnce(true)
    const old = detectSparseCheckoutCached(root, worktree)
    clearSparseCheckoutStateCacheForRepo(root)
    held.resolve(false)
    await old

    expect(await detectSparseCheckoutCached(root, worktree)).toBe(true)
  })

  it('does not publish a revalidation superseded by a sparse toggle', async () => {
    expect(await detectSparseCheckoutCached(root, worktree)).toBe(false)
    vi.advanceTimersByTime(300_000)
    const held = deferredProbe()
    probe.mockReturnValueOnce(held.promise)
    const changed = vi.fn()
    onSparseCheckoutStateChanged(changed)
    await detectSparseCheckoutCached(root, worktree)
    invalidateSparseCheckoutState(root, worktree)
    expect(await detectSparseCheckoutCached(root, worktree)).toBe(false)
    held.resolve(true)
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(changed).not.toHaveBeenCalled()
    expect(await detectSparseCheckoutCached(root, worktree)).toBe(false)
  })

  it('retries failed cold and background probes without replacing a known answer with a failure', async () => {
    probe.mockRejectedValueOnce(new Error('unreadable'))
    await expect(detectSparseCheckoutCached(root, worktree)).rejects.toThrow('unreadable')
    expect(await detectSparseCheckoutCached(root, worktree)).toBe(false)
    vi.advanceTimersByTime(300_000)
    const held = deferredProbe()
    probe.mockReturnValueOnce(held.promise)
    expect(await detectSparseCheckoutCached(root, worktree)).toBe(false)
    held.reject(new Error('offline'))
    await new Promise<void>((resolve) => setImmediate(resolve))
    await enableSparse()
    const changed = new Promise<void>((resolve) => onSparseCheckoutStateChanged(() => resolve()))

    expect(await detectSparseCheckoutCached(root, worktree)).toBe(false)
    await changed
    expect(await detectSparseCheckoutCached(root, worktree)).toBe(true)
  })

  it('rejects aborted probes promptly and does not retain their late answers', async () => {
    const held = deferredProbe()
    const controller = new AbortController()
    const reason = new Error('closed')
    probe.mockReturnValueOnce(held.promise).mockResolvedValueOnce(true)
    const pending = detectSparseCheckoutCached(root, worktree, { signal: controller.signal })
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
    held.resolve(false)
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(await detectSparseCheckoutCached(root, worktree)).toBe(true)
  })
})
