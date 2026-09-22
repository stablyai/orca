import { runProcess } from '../shared/child-process/run-process'
import { parseProcessTable } from './pty-process-table-parser'
import type { ProcessTableCapture } from './pty-descendant-termination'

export const TTY_PROCESS_TABLE_TIMEOUT_MS = 500
const TTY_PROCESS_TABLE_MAX_BYTES = 1024 * 1024
/** Device names Orca itself derived from node-pty: 'ttys003' on macOS, 'pts/3' on Linux. */
const TTY_NAME_PATTERN = /^[A-Za-z0-9]+(?:\/\d+)?$/

export type TtyProcessTableReader = (
  ttyName: string,
  timeoutMs?: number
) => Promise<ProcessTableCapture | null>

/**
 * Everything still attached to one terminal.
 *
 * Why `ps -t` rather than a `tty=` column on the whole-host capture: on macOS
 * that column reads each process's terminal individually, which measured 12.9s
 * against 0.16s for the same table without it — far past any teardown budget.
 * Selecting by terminal asks the same question of ~one pane's worth of rows.
 *
 * Resolves null when ps fails or the terminal is gone; that is "unknown", never
 * "nothing is attached".
 */
export const readTtyProcessTable: TtyProcessTableReader = (ttyName, timeoutMs) => {
  if (!TTY_NAME_PATTERN.test(ttyName)) {
    return Promise.resolve(null)
  }
  const capturedAtMs = Date.now()
  // ps fails once the device itself is gone, which is the same "nothing to
  // read here" as a genuine failure for every caller of this reader.
  return runProcess({
    program: 'ps',
    args: ['-t', ttyName, '-o', 'pid=,ppid=,pgid=,lstart='],
    maxOutputBytes: TTY_PROCESS_TABLE_MAX_BYTES,
    timeoutMs: timeoutMs ?? TTY_PROCESS_TABLE_TIMEOUT_MS,
    // ps localizes lstart; delayed identity checks must parse it the same way everywhere.
    env: { ...process.env, LANG: 'C', LC_ALL: 'C' }
  }).then(
    (result) =>
      result.code === 0 && !result.timedOut && !result.outputTruncated
        ? { rows: parseProcessTable(result.stdout), capturedAtMs }
        : null,
    () => null
  )
}
