import { execFile } from 'node:child_process'
import { basename } from 'node:path'

export type CopyHostProcessRow = {
  pid: number
  ppid: number
  name: string
  command: string
  creationTimeMs?: number
}

const PS_ARGS = ['-axo', 'pid=,ppid=,lstart=,command=']
const PS_TIMEOUT_MS = 10_000
// Busy hosts can exceed execFile's 1MB default; a truncated table would miss a holder.
const PS_MAX_BUFFER_BYTES = 32 * 1024 * 1024
// lstart in the C locale, e.g. `Thu Nov  5 10:00:00 2026`.
const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\w{3} \w{3}\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4})\s+(.*)$/

/** Rows from `ps -axo pid=,ppid=,lstart=,command=`; ps joins argv with spaces and drops quotes. */
export function parsePosixProcessTable(stdout: string): CopyHostProcessRow[] {
  const rows: CopyHostProcessRow[] = []
  for (const line of stdout.split('\n')) {
    const match = PS_LINE.exec(line)
    if (!match) {
      continue
    }
    const command = match[4].trim()
    const started = Date.parse(match[3])
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      name: basename(command.split(' ')[0] ?? ''),
      command,
      ...(Number.isFinite(started) ? { creationTimeMs: started } : {})
    })
  }
  return rows
}

/** The process table of this macOS (or other POSIX) host, with each command line. */
export function readPosixProcessTable(): Promise<CopyHostProcessRow[]> {
  // Pin the locale so lstart parses the same everywhere.
  const env = { ...process.env, LANG: 'C', LC_ALL: 'C' }
  return new Promise((resolve, reject) => {
    execFile(
      'ps',
      PS_ARGS,
      { env, timeout: PS_TIMEOUT_MS, maxBuffer: PS_MAX_BUFFER_BYTES, killSignal: 'SIGKILL' },
      (error, stdout) => (error ? reject(error) : resolve(parsePosixProcessTable(stdout)))
    )
  })
}
