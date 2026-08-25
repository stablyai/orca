import { describe, expect, it, vi } from 'vitest'
import { readWindowsConptyProcessIds } from './windows-conpty-process-membership'

describe('readWindowsConptyProcessIds', () => {
  it('fails closed without forking a console-list helper', async () => {
    const forkProcess = vi.fn()
    const readWithInjectedFork = readWindowsConptyProcessIds as unknown as (
      rootPid: number,
      options: { forkProcess: typeof forkProcess }
    ) => Promise<ReadonlySet<number> | null>

    await expect(readWithInjectedFork(101, { forkProcess })).resolves.toBeNull()
    expect(forkProcess).not.toHaveBeenCalled()
  })
})
