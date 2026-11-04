import type { ProfileStateWriterThread } from './profile-state-writer-thread'
import { startProfileStateWriterSlowWarning } from './profile-state-writer-slow-warning'

export async function awaitProfileStateWriterExit(
  thread: Pick<ProfileStateWriterThread, 'exited' | 'exitPromise'> | undefined,
  requestId: number,
  options: { warningMs: number; clock?: () => number; acknowledgedRevision: () => number }
): Promise<void> {
  if (!thread || thread.exited) {
    return
  }
  const clearSlowWarning = startProfileStateWriterSlowWarning({
    warningMs: options.warningMs,
    phase: 'awaiting-exit',
    now: options.clock,
    request: {
      command: 'close',
      requestId,
      acknowledgedRevision: options.acknowledgedRevision()
    }
  })
  try {
    await thread.exitPromise
  } finally {
    clearSlowWarning()
  }
}
