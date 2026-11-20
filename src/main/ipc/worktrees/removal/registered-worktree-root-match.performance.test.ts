import { AsyncLocalStorage, createHook } from 'node:async_hooks'
import { afterEach, expect, it, vi } from 'vitest'
import type * as Containment from '../../../filesystem/local-file-io/filesystem-path-containment'
import { findRegisteredWorktreeRootAsync } from './registered-worktree-root-match'

const probe = vi.hoisted(
  (): { read: null | ((target: string, root: string) => boolean | Promise<boolean>) } => ({
    read: null
  })
)
vi.mock('../../../filesystem/local-file-io/filesystem-path-containment', async (importOriginal) => {
  const actual = await importOriginal<typeof Containment>()
  return {
    ...actual,
    isDescendantOrEqualAsync: (target: string, root: string) =>
      probe.read ? probe.read(target, root) : actual.isDescendantOrEqualAsync(target, root)
  }
})
afterEach(() => {
  probe.read = null
})

it.each([750, 7500])(
  'keeps ASCII containment synchronous across %i registered roots',
  async (count) => {
    const scope = new AsyncLocalStorage<boolean>()
    let promises = 0
    const hook = createHook({
      init: (_id, type) => {
        if (type === 'PROMISE' && scope.getStore()) {
          promises++
        }
      }
    })
    const roots = Array.from({ length: count }, (_, index) => `/worktrees/root-${index}`)
    hook.enable()
    try {
      const result = await scope.run(true, () =>
        findRegisteredWorktreeRootAsync('/outside/shot.png', roots)
      )
      expect(result).toBeNull()
    } finally {
      hook.disable()
    }
    expect(promises).toBe(1)
    await expect(
      findRegisteredWorktreeRootAsync('/worktrees/root-7/shot.png', roots)
    ).resolves.toBe('/worktrees/root-7')
  }
)

it.each([1, 10])(
  'pins remaining roots before a Unicode probe can refresh the live set %i times',
  async (refreshes) => {
    const roots = new Set(['/worktrees/café', '/worktrees/café'])
    let reads = 0
    probe.read = (_target, root) => {
      if (root === '/worktrees/café') {
        return true
      }
      reads++
      return new Promise<boolean>((resolve) =>
        queueMicrotask(() => {
          if (reads <= refreshes) {
            roots.clear()
            roots.add('/worktrees/café')
            roots.add('/worktrees/café')
          }
          resolve(false)
        })
      )
    }
    await expect(findRegisteredWorktreeRootAsync('/worktrees/café/shot.png', roots)).resolves.toBe(
      '/worktrees/café'
    )
    expect(reads).toBe(1)
  }
)
