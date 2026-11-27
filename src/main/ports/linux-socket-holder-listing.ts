import type { ChildProcess } from 'node:child_process'
import { spawnProcess } from '@orca/process-host'
import {
  PORT_SCAN_COMMAND_TIMEOUT_MS,
  PortScanCommandTimeoutError
} from './port-scan-command-protocol'

// Worker-only. `exec` leaves one ls process (no pipeline) so a timeout or quit kill ends the whole listing; directory
// arguments (one per process, not per fd) keep a busy machine under the exec argument limit.
// -q prints control characters (newlines included) as '?', so no open file's name can forge a header or row.
const LISTING_SCRIPT = 'exec ls -lnq /proc/[0-9]*/fd 2>/dev/null'
const MAX_LINE_CHARS = 4096
// LC_ALL=C pins `ls -ln` to `mode links uid gid size Mon DD HH:MM|YYYY fd -> target`: 11 fields for an fd row.
const FD_ROW_FIELDS = 11

/** Streams `ls -ln /proc/<pid>/fd` output, keeping holders of wanted inodes and a count of well-formed socket rows. */
export class LinuxSocketHolderFilter {
  private pending = ''
  private pid: string | null = null
  private seen = 0
  private holders = ''
  private discarding = false

  constructor(private readonly wanted: ReadonlySet<number>) {}

  write(chunk: string): void {
    this.pending += chunk
    let newline: number
    while ((newline = this.pending.indexOf('\n')) !== -1) {
      if (!this.discarding) {
        this.line(this.pending.slice(0, newline))
      }
      this.discarding = false
      this.pending = this.pending.slice(newline + 1)
    }
    // An over-long line is a path, never a header; drop just that line without buffering it.
    if (this.pending.length > MAX_LINE_CHARS) {
      this.pending = ''
      this.discarding = true
    }
  }

  /** `<pid> socket:[<inode>]` lines, then `seen <n>`. */
  finish(): string {
    if (!this.discarding) {
      this.line(this.pending)
    }
    this.pending = ''
    return `${this.holders}seen ${this.seen}\n`
  }

  private line(line: string): void {
    const header = /^\/proc\/(\d+)\/fd:$/.exec(line)
    if (header) {
      this.pid = header[1]
      return
    }
    const fields = line.trim().split(/\s+/)
    if (
      this.pid === null ||
      fields.length !== FD_ROW_FIELDS ||
      fields[9] !== '->' ||
      !/^\d+$/.test(fields[8])
    ) {
      return
    }
    const socket = /^socket:\[(\d+)\]$/.exec(fields[10])
    if (!socket) {
      return
    }
    this.seen += 1
    if (this.wanted.has(Number(socket[1]))) {
      this.holders += `${this.pid} ${fields[10]}\n`
    }
  }
}

/** Run the listing as one process; `track` registers it for shutdown kills and returns its release. */
export function runLinuxSocketHolderListing(
  inodes: readonly number[],
  track: (child: ChildProcess) => () => void
): Promise<{ stdout: string; spawnMs: number }> {
  const filter = new LinuxSocketHolderFilter(new Set(inodes))
  const startedAt = Date.now()
  const child = spawnProcess({
    program: '/bin/sh',
    args: ['-c', LISTING_SCRIPT],
    // Only PATH: TIME_STYLE, QUOTING_STYLE and friends change GNU ls's layout and LC_ALL doesn't override them.
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LC_ALL: 'C' },
    stdio: ['ignore', 'pipe', 'ignore']
  })
  const spawnMs = Date.now() - startedAt
  const release = track(child)
  return new Promise((resolve, reject) => {
    let settled = false
    const settle = (error?: unknown): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      release()
      if (error) {
        child.kill()
        reject(error)
      } else {
        resolve({ stdout: filter.finish(), spawnMs })
      }
    }
    const timer = setTimeout(
      () => settle(new PortScanCommandTimeoutError('Linux socket listing timed out')),
      PORT_SCAN_COMMAND_TIMEOUT_MS
    )
    child.once('error', (error) => settle(error))
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      if (!settled) {
        filter.write(chunk)
      }
    })
    child.stdout?.on('error', (error) => settle(error))
    // ls exits non-zero when some fd directories are unreadable; only a signal means the listing was cut short.
    child.once('close', (_code, signal) =>
      settle(signal ? new Error('Linux socket listing was interrupted.') : undefined)
    )
  })
}
