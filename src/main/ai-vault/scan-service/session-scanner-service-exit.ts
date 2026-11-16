import type { ChildProcess } from 'node:child_process'
import { startSpan } from '../../observability/tracer'

const STDERR_TAIL_CHARS = 4_096
// Markers can straddle chunk boundaries.
const STDERR_MARKER_OVERLAP_CHARS = 256
const EXIT_RECORD_TIMEOUT_MS = 5_000
// V8 prints this line, then native frames, just before aborting a process out of heap.
const V8_FATAL_LINE = /FATAL ERROR:[^\n]*/
const HEAP_EXHAUSTED_MARKERS =
  /JavaScript heap out of memory|Reached heap limit|Ineffective mark-compacts near heap limit/

type ChildStderr = { tail: string; fatal: string | null; outOfMemory: boolean }

const childStderr = new WeakMap<ChildProcess, ChildStderr>()

export function trackAiVaultServiceStderr(child: ChildProcess, chunk: string): void {
  const stderr = childStderr.get(child) ?? { tail: '', fatal: null, outOfMemory: false }
  const window = stderr.tail.slice(-STDERR_MARKER_OVERLAP_CHARS) + chunk
  stderr.fatal ??= V8_FATAL_LINE.exec(window)?.[0] ?? null
  stderr.outOfMemory ||= HEAP_EXHAUSTED_MARKERS.test(window)
  stderr.tail = (stderr.tail + chunk).slice(-STDERR_TAIL_CHARS)
  childStderr.set(child, stderr)
}

/** Write why a faulted child died to the trace log once its stderr has drained. */
export function recordAiVaultServiceExit(
  child: ChildProcess,
  fault: Error,
  onRecorded: (outOfMemory: boolean) => void
): void {
  let recorded = false
  const record = (): void => {
    if (recorded) {
      return
    }
    recorded = true
    clearTimeout(timer)
    const stderr = childStderr.get(child)
    const outOfMemory = stderr?.outOfMemory === true
    const span = startSpan('aiVault.service.exit', {
      attributes: {
        pid: child.pid,
        code: child.exitCode,
        signal: child.signalCode,
        fault: fault.message,
        outOfMemory,
        ...(stderr?.fatal ? { fatal: stderr.fatal.trim() } : {}),
        stderr: stderr?.tail.trim() ?? ''
      }
    })
    span.fail(outOfMemory ? 'AI Vault service ran out of memory.' : fault.message)
    onRecorded(outOfMemory)
  }
  // A fault always precedes 'close', which fires after stderr ends.
  child.once('close', record)
  const timer = setTimeout(record, EXIT_RECORD_TIMEOUT_MS)
  timer.unref?.()
}
