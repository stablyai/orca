import { execFile } from 'node:child_process'
import {
  inProcessDeadlineAllowanceMs,
  inProcessSliceMs,
  runPsInProcess
} from '../shared/libproc-process-table'
import { parseProcessTable, type ProcessTableRow } from './pty-process-table-parser'

export const DESCENDANT_SNAPSHOT_TIMEOUT_MS = 1_000
// Busy hosts can exceed execFile’s 1MB default; truncated output would omit descendants.
const PS_MAX_BUFFER_BYTES = 32 * 1024 * 1024

export type ProcessTableCapture = {
  rows: ProcessTableRow[]
  /** Start boundary of the scan that produced rows, never a later consumer's time. */
  capturedAtMs: number
}

export type ProcessTableReader = {
  (timeoutMs?: number): Promise<ProcessTableCapture>
  /** Time the reader may spend in process before giving ps its whole timeout; outer deadlines add it. Absent: none. */
  deadlineAllowanceMs?: (timeoutMs: number) => number
}

const DESCENDANT_PS_ARGS = ['-axo', 'pid=,ppid=,pgid=,tpgid=,lstart=']

export const readFreshProcessTable: ProcessTableReader = Object.assign(readFreshProcessTableOnce, {
  deadlineAllowanceMs: inProcessDeadlineAllowanceMs
})

async function readFreshProcessTableOnce(
  timeoutMs = DESCENDANT_SNAPSHOT_TIMEOUT_MS
): Promise<ProcessTableCapture> {
  // Stamp before ps starts so a capture-second PID cannot appear older after a clock rollover.
  const capturedAtMs = Date.now()
  // Pin lstart’s locale so delayed identity checks parse it consistently.
  const env = { ...process.env, LANG: 'C', LC_ALL: 'C' }
  // Registered now, so no native read submitted before this request serves it; a stalled one leaves ps its full timeout.
  const inProcess = await runPsInProcess(DESCENDANT_PS_ARGS, {
    env,
    timeoutMs: inProcessSliceMs(timeoutMs)
  })
  if (inProcess && !inProcess.timedOut) {
    return { rows: parseProcessTable(inProcess.stdout), capturedAtMs }
  }
  const options = { maxBuffer: PS_MAX_BUFFER_BYTES, timeout: timeoutMs, env }
  return new Promise((resolve, reject) => {
    execFile('ps', DESCENDANT_PS_ARGS, { ...options, killSignal: 'SIGKILL' }, (error, stdout) =>
      error ? reject(error) : resolve({ rows: parseProcessTable(stdout), capturedAtMs })
    )
  })
}
