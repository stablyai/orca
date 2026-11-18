import { forceTerminateProcessTree, signalProcessTree } from './process-tree-termination'
import { inFlightWindowsTreeKill } from './windows-tree-kill'
import type { BufferedProcessSpawn, ProcessChild, ProcessSpec } from './process-spec'

export function createProcessTreeActions(
  spec: ProcessSpec,
  child: ProcessChild,
  hosted: BufferedProcessSpawn | undefined,
  markBarrierTerminationVerified: () => void
): {
  signalBarrierTree: (signal?: NodeJS.Signals) => Promise<boolean>
  forceBarrierTree: () => Promise<boolean>
  killRootUnlessTreeKillInFlight: () => void
} {
  const withPid = (action: () => Promise<boolean>): Promise<boolean> => {
    if (!hosted?.withPid) {
      return action()
    }
    return hosted.withPid(() => {
      const pending = action()
      // PID delivery may outlive the caller's wait; keep observing the actual tree kill.
      void inFlightWindowsTreeKill(child)?.then(
        (verdict) => verdict === 'exited' && markBarrierTerminationVerified()
      )
      void pending.then((verified) => verified && markBarrierTerminationVerified())
      return pending
    })
  }
  const signalBarrierTree = (signal?: NodeJS.Signals): Promise<boolean> =>
    withPid(() =>
      (typeof spec.terminationBarrier === 'object'
        ? spec.terminationBarrier.signal(child, signal)
        : signalProcessTree(child, signal)
      ).catch(() => false)
    )
  const forceBarrierTree = (): Promise<boolean> =>
    withPid(() =>
      (typeof spec.terminationBarrier === 'object'
        ? spec.terminationBarrier.force(child)
        : forceTerminateProcessTree(child)
      ).catch(() => false)
    )

  // Let taskkill finish reading the tree before killing the root, or descendants may be orphaned.
  const killRootUnlessTreeKillInFlight = (): void => {
    void withPid(() => {
      if (!inFlightWindowsTreeKill(child)) {
        terminate(child, 'SIGKILL')
      }
      return Promise.resolve(false)
    })
  }

  return { signalBarrierTree, forceBarrierTree, killRootUnlessTreeKillInFlight }
}

// Best-effort root termination; tree termination is handled separately.
export function terminate(child: ProcessChild, signal?: NodeJS.Signals): void {
  try {
    child.kill(signal)
  } catch {
    /* already gone */
  }
}
