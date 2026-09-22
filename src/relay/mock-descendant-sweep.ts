import { vi } from 'vitest'

// Mock PTYs reuse the runner PID; never enumerate or signal its real descendants.
vi.mock('../main/pty-descendant-termination', () => ({
  killWithDescendantSweep: async (_pid: number, killRoot: () => void): Promise<void> => {
    killRoot()
  }
}))

vi.mock('../main/pty-descendant-tree-reap', () => ({
  reapDescendantTree: async (
    _pid: number,
    killRoot: () => void
  ): Promise<'exited' | 'live' | 'unverifiable'> => {
    killRoot()
    return 'exited'
  }
}))
