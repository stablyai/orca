import type { TerminalGestureInputReport } from '../terminal/terminal-gesture-input'
import type {
  TerminalGestureInputQueue,
  TerminalGestureInputRun
} from './mobile-session-route-types'

/**
 * Scroll reports in one direction are interchangeable, so those still queued collapse into one
 * run that repeats the newest report at most `maxQueuedScrollReports` times: a backlog built up
 * behind a slow reply is sent as a short scroll from where the finger is now.
 */
export function appendTerminalGestureInput(
  queue: TerminalGestureInputQueue,
  reports: readonly TerminalGestureInputReport[],
  nowMs: number,
  maxQueuedScrollReports: number
): void {
  let run: TerminalGestureInputRun | undefined
  for (const report of reports) {
    if (report.scrollDirection) {
      const tail = queue.runs.at(-1)
      if (tail?.scroll?.direction === report.scrollDirection) {
        tail.sequenceCount = Math.min(tail.sequenceCount + 1, maxQueuedScrollReports)
        tail.scroll.report = report.bytes
        tail.bytes = report.bytes.repeat(tail.sequenceCount)
        tail.queuedAtMs = nowMs
      } else {
        queue.runs.push({
          kind: report.kind,
          bytes: report.bytes,
          sequenceCount: 1,
          queuedAtMs: nowMs,
          scroll: { direction: report.scrollDirection, report: report.bytes }
        })
      }
      run = undefined
      continue
    }
    if (run?.kind === report.kind) {
      run.bytes += report.bytes
      run.sequenceCount += 1
    } else {
      run = { kind: report.kind, bytes: report.bytes, sequenceCount: 1, queuedAtMs: nowMs }
      queue.runs.push(run)
    }
  }
}

/** Movement older than `maxAgeMs` would move the program long after the finger did; a click is never stale. */
export function dropStaleTerminalGestureMovement(
  queue: TerminalGestureInputQueue,
  nowMs: number,
  maxAgeMs: number
): void {
  queue.runs = queue.runs.filter(
    (run) => run.kind === 'click' || nowMs - run.queuedAtMs <= maxAgeMs
  )
}

export function hasQueuedTerminalGestureClick(queue: TerminalGestureInputQueue): boolean {
  return queue.runs.some((run) => run.kind === 'click')
}

export function queuedTerminalGestureSequenceCount(queue: TerminalGestureInputQueue): number {
  return queue.runs.reduce((total, run) => total + run.sequenceCount, 0)
}

export function queuedTerminalGestureBytes(queue: TerminalGestureInputQueue): string {
  return queue.runs.map((run) => run.bytes).join('')
}

/** Removes and returns the bytes of one send: whole runs from the front, in order, up to `maxSequences`. */
export function takeTerminalGestureInputBatch(
  queue: TerminalGestureInputQueue,
  maxSequences: number
): string {
  let bytes = ''
  let sequenceCount = 0
  while (queue.runs.length > 0) {
    const run = queue.runs[0]
    // Why: a run is never split, so one larger than the cap still goes out, alone.
    if (sequenceCount > 0 && sequenceCount + run.sequenceCount > maxSequences) {
      break
    }
    bytes += run.bytes
    sequenceCount += run.sequenceCount
    queue.runs.shift()
  }
  return bytes
}
