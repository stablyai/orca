import { startSpan } from '../observability/tracer'

/** A filesystem task that outlived its deadline. The trace keeps it in a packaged app; scanner
 *  workers install no trace sink, so the console line stays. */
export function reportWslTranscriptFsTimeout(
  task: { priority: string; key: string },
  timeoutMs: number,
  error: Error
): void {
  startSpan('wslTranscriptFs.timeout', {
    attributes: { priority: task.priority, timeoutMs, taskKey: task.key }
  }).fail(error)
  console.warn(
    `[wsl-transcript-fs-gate] ${task.priority} filesystem task exceeded ` +
      `${timeoutMs}ms; replacing its I/O process: ${task.key}`
  )
}
