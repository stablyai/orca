import { vi } from 'vitest'

// Mock subprocess PIDs must never reach the host process table or signal real descendants.
vi.mock('../pty-descendant-termination', () => ({
  killWithDescendantSweep: async (_pid: number, killRoot: () => void): Promise<void> => {
    killRoot()
  }
}))
