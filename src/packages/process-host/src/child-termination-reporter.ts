import type { ChildProcess } from 'node:child_process'
import type { ProcessSpec } from './process-spec'

export type ChildTerminationReporter = {
  report: () => void
  reportIf: (confirmed: boolean) => void
}

export function createChildTerminationReporter(callback?: () => void): ChildTerminationReporter {
  let reported = false
  const report = (): void => {
    if (reported) {
      return
    }
    reported = true
    callback?.()
  }
  return { report, reportIf: (confirmed) => (confirmed ? report() : undefined) }
}

export function canReportChildClose(
  barrier: ProcessSpec['terminationBarrier'],
  stopping: boolean,
  code: number | null,
  signal: NodeJS.Signals | null
): boolean {
  if (stopping && barrier) {
    return false
  }
  return (
    typeof barrier !== 'object' ||
    (code !== null && signal === null && (barrier.isExitVerified?.() ?? true))
  )
}

// Best-effort root termination; tree termination is handled separately.
export function terminateChild(child: ChildProcess, signal?: NodeJS.Signals): void {
  try {
    child.kill(signal)
  } catch {
    /* already gone */
  }
}
