import { vi } from 'vitest'
import type * as PtyDescendantTermination from '../pty-descendant-termination'

// Mock subprocess PIDs must never reach the host process table or signal real descendants.
vi.mock('../pty-descendant-termination', async (original) => ({
  DESCENDANT_SNAPSHOT_TIMEOUT_MS: (await original<typeof PtyDescendantTermination>())
    .DESCENDANT_SNAPSHOT_TIMEOUT_MS,
  killWithDescendantSweep: async (_pid: number, killRoot: () => void): Promise<void> => {
    killRoot()
  }
}))
