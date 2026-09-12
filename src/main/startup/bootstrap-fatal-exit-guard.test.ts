import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BOOTSTRAP_FATAL_EXIT_GUARD_KEY,
  removeBootstrapFatalExitGuard
} from './bootstrap-fatal-exit-guard'

type BootstrapFatalExitGlobal = typeof globalThis & {
  [BOOTSTRAP_FATAL_EXIT_GUARD_KEY]?: () => void
}

const bootstrapGlobal = globalThis as BootstrapFatalExitGlobal

afterEach(() => {
  delete bootstrapGlobal[BOOTSTRAP_FATAL_EXIT_GUARD_KEY]
})

describe('bootstrap fatal exit guard', () => {
  it('removes the generated pre-import guard', () => {
    const removeGuard = vi.fn()
    bootstrapGlobal[BOOTSTRAP_FATAL_EXIT_GUARD_KEY] = removeGuard

    removeBootstrapFatalExitGuard()

    expect(removeGuard).toHaveBeenCalledOnce()
    expect(bootstrapGlobal[BOOTSTRAP_FATAL_EXIT_GUARD_KEY]).toBeUndefined()
  })
})
