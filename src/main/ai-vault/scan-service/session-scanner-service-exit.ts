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

const FATAL_LINE_MAX_CHARS = 512

type ChildStderr = {
  tail: string
  fatal: string | null
  fatalComplete: boolean
  outOfMemory: boolean
}

const childStderr = new WeakMap<ChildProcess, ChildStderr>()

export function trackAiVaultServiceStderr(child: ChildProcess, chunk: string): void {
  const stderr = childStderr.get(child) ?? {
    tail: '',
    fatal: null,
    fatalComplete: false,
    outOfMemory: false
  }
  const window = stderr.tail.slice(-STDERR_MARKER_OVERLAP_CHARS) + chunk
  if (stderr.fatal === null) {
    const match = V8_FATAL_LINE.exec(window)
    stderr.fatal = match?.[0] ?? null
    stderr.fatalComplete = match !== null && window.includes('\n', match.index)
  } else if (!stderr.fatalComplete) {
    // The fatal line can arrive split across chunks.
    const rest = /^[^\n]*/.exec(chunk)?.[0] ?? ''
    stderr.fatal = (stderr.fatal + rest).slice(0, FATAL_LINE_MAX_CHARS)
    stderr.fatalComplete = rest.length < chunk.length || stderr.fatal.length >= FATAL_LINE_MAX_CHARS
  }
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
