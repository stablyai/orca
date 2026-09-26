import { vi } from 'vitest'

// Mock PTYs reuse the runner PID; never enumerate or signal its real descendants.
vi.mock('../main/pty-descendant-termination', () => ({
  killWithDescendantSweep: async (_pid: number, killRoot: () => void): Promise<void> => {
    killRoot()
  }
}))
