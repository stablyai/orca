import { vi } from 'vitest'

type DescendantSnapshot = { rootPgid: number | null; descendants: never[]; capturedAtMs: number }

/** A test can hand the next graceful sweep a captured snapshot, as a real POSIX capture would. */
export const descendantCapture: { snapshot: DescendantSnapshot | null } = { snapshot: null }

// Mock subprocess PIDs must never reach the host process table or signal real descendants.
vi.mock('../../../pty/process-retirement/pty-descendant-termination', () => ({
  killWithDescendantSweep: async (
    _pid: number,
    killRoot: () => void,
    deps: {
      ownsRoot?: () => boolean
      terminateDescendants?: (snapshot: DescendantSnapshot) => unknown
      awaitEscalation?: boolean | (() => boolean)
    } = {}
  ): Promise<void> => {
    const snapshot = descendantCapture.snapshot
    descendantCapture.snapshot = null
    const awaitEscalation =
      typeof deps.awaitEscalation === 'function' ? deps.awaitEscalation() : deps.awaitEscalation
    // Graceful order: descendants are signalled before the root, whose signal may then throw.
    try {
      if (snapshot && !awaitEscalation && (deps.ownsRoot?.() ?? true)) {
        void deps.terminateDescendants?.(snapshot)
      }
    } finally {
      killRoot()
    }
  }
}))
