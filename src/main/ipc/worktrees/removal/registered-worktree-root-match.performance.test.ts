import { AsyncLocalStorage, createHook } from 'node:async_hooks'
import { expect, it } from 'vitest'
import { findRegisteredWorktreeRootAsync } from './registered-worktree-root-match'

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
