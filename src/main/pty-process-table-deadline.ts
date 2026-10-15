import type { ProcessTableCapture, ProcessTableReader } from './pty-descendant-termination'

/** An unreadable or overdue table never supplies identities to a signal caller. */
export function readProcessTableBeforeDeadline(
  readTable: ProcessTableReader,
  timeoutMs: number,
  keepAlive = false
): Promise<ProcessTableCapture | null> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (capture: ProcessTableCapture | null): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      resolve(capture)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    if (!keepAlive) {
      timer.unref?.()
    }
    try {
      void readTable(timeoutMs).then(finish, () => finish(null))
    } catch {
      finish(null)
    }
  })
}

/** Retry transient failures without moving the original snapshot's identity boundary. */
export async function readProcessTableWithRetries(
  readTable: ProcessTableReader,
  timeoutMs: number,
  keepAlive: boolean,
  ownsRoot?: () => boolean
): Promise<ProcessTableCapture | null> {
  const deadline = performance.now() + timeoutMs
  while (ownsRoot?.() ?? true) {
    const remainingMs = Math.ceil(deadline - performance.now())
    if (remainingMs <= 0) {
      return null
    }
    const capture = await readProcessTableBeforeDeadline(readTable, remainingMs, keepAlive)
    if (!(ownsRoot?.() ?? true)) {
      return null
    }
    if (capture) {
      return capture
    }
    const backoffMs = Math.min(50, Math.ceil(deadline - performance.now()))
    if (backoffMs <= 0) {
      return null
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, backoffMs)
      if (!keepAlive) {
        timer.unref?.()
      }
    })
  }
  return null
}
