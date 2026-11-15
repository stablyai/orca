import { setImmediate as yieldToEvents } from 'node:timers/promises'
import type { Writable } from 'node:stream'

/** One bounded record at a time; a stopped attempt also releases an outstanding drain wait. */
export async function producePromptRecords(
  stdin: Writable,
  records: Iterable<string>,
  signal: AbortSignal,
  active: () => boolean
): Promise<void> {
  let batch = 0
  for (const record of records) {
    if (!active()) {
      return
    }
    if (!stdin.write(record)) {
      await new Promise<void>((resolve) => {
        const done = (): void => {
          stdin.off('drain', done)
          stdin.off('error', done)
          stdin.off('close', done)
          signal.removeEventListener('abort', done)
          resolve()
        }
        stdin.once('drain', done)
        stdin.once('error', done)
        stdin.once('close', done)
        signal.addEventListener('abort', done, { once: true })
        if (!active() || stdin.destroyed || stdin.writableEnded) {
          done()
        }
      })
      if (!active() || stdin.destroyed || stdin.writableEnded) {
        return
      }
    }
    if (++batch === 16) {
      batch = 0
      await yieldToEvents()
      if (!active()) {
        return
      }
    }
  }
  if (active()) {
    stdin.end()
  }
}
