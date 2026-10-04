import { runProcess } from '../shared/child-process/run-process'
import { parseProcessTable } from './pty-process-table-parser'
import type { ProcessTableCapture } from './pty-descendant-termination'

const PS_MAX_BUFFER_BYTES = 32 * 1024 * 1024

async function readRows(
  args: string[],
  timeoutMs: number,
  field: 'command' | 'executable' = 'command'
): Promise<ProcessTableCapture> {
  const capturedAtMs = Date.now()
  const result = await runProcess({
    program: 'ps',
    args,
    maxOutputBytes: PS_MAX_BUFFER_BYTES,
    timeoutMs,
    env: { ...process.env, LANG: 'C', LC_ALL: 'C' }
  })
  if (result.code !== 0 || result.timedOut || result.outputTruncated) {
    throw new Error('Process table unavailable')
  }
  return { rows: parseProcessTable(result.stdout, field), capturedAtMs }
}

/** Only potential shared service leaders need argv; tools' argument lists can be enormous. */
export async function readFreshProcessTable(timeoutMs = 1_000): Promise<ProcessTableCapture> {
  const deadline = Date.now() + timeoutMs
  const capture = await readRows(
    ['-axww', '-o', 'pid=,ppid=,pgid=,lstart=,comm='],
    timeoutMs,
    'executable'
  )
  const candidates = capture.rows.filter(
    (row) => row.pid === row.pgid && row.executable?.split('/').at(-1) === 'codex'
  )
  if (candidates.length === 0) {
    return capture
  }
  const remainingMs = deadline - Date.now()
  if (remainingMs <= 0) {
    throw new Error('Process command capture deadline exceeded')
  }
  const commands = await readRows(
    [
      '-ww',
      '-p',
      candidates.map((row) => row.pid).join(','),
      '-o',
      'pid=,ppid=,pgid=,lstart=,command='
    ],
    remainingMs
  )
  const byPid = new Map(commands.rows.map((row) => [row.pid, row]))
  if (
    byPid.size !== commands.rows.length ||
    new Set(candidates.map((row) => row.pid)).size !== candidates.length
  ) {
    throw new Error('Ambiguous process command capture')
  }
  for (const row of candidates) {
    const live = byPid.get(row.pid)
    if (
      !live?.command ||
      live.startedAt !== row.startedAt ||
      live.pgid !== row.pgid ||
      live.ppid !== row.ppid
    ) {
      throw new Error('Process changed during command capture')
    }
    row.command = live.command
  }
  return capture
}

export function readProcessIdentities(
  pids: number[],
  timeoutMs = 1_000
): Promise<ProcessTableCapture> {
  return readRows(['-p', pids.join(','), '-o', 'pid=,ppid=,pgid=,lstart='], timeoutMs)
}
