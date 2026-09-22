import { vi } from 'vitest'

// Mock subprocess PIDs must never reach the host process table or signal real descendants.
vi.mock('../pty-descendant-termination', () => ({
  killWithDescendantSweep: async (_pid: number, killRoot: () => void): Promise<void> => {
    killRoot()
  }
}))

vi.mock('../pty-descendant-tree-reap', () => ({
  reapDescendantTree: async (
    _pid: number,
    killRoot: () => void
  ): Promise<'exited' | 'live' | 'unverifiable'> => {
    killRoot()
    return 'exited'
  }
}))
