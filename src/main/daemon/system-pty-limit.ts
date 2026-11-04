import { runProcess } from '@orca/process-host'
import { readNodeFileWithinLimit } from '../../shared/node-bounded-file-reader'
import { InFlightPromiseDedupe } from '../../shared/in-flight-promise-dedupe'
import { awaitDaemonValueWithinCallerDeadline } from './daemon-request-deadline'

function positiveInteger(raw: string): number | null {
  const text = raw.trim()
  const value = Number(text)
  return /^\d+$/.test(text) && Number.isSafeInteger(value) && value > 0 ? value : null
}

export function parseLinuxPtyLimit(globalRaw: string, mounts: string): number | null {
  const global = positiveInteger(globalRaw)
  if (global === null) {
    return null
  }
  const instance = mounts.split('\n').find((line) => {
    const fields = line.split(/\s+/)
    return fields[1] === '/dev/pts' && fields[2] === 'devpts'
  })
  const maximum = instance
    ?.split(/\s+/)[3]
    ?.split(',')
    .find((part) => part.startsWith('max='))
  const local = maximum ? positiveInteger(maximum.slice(4)) : null
  // The reserve belongs to mount namespaces, not UIDs; this reports capacity, never free slots.
  return maximum && local === null ? null : Math.min(global, local ?? global)
}

async function probeSystemPtyLimit(): Promise<number | null> {
  if (process.platform === 'darwin') {
    const result = await runProcess({
      program: '/usr/sbin/sysctl',
      args: ['-n', 'kern.tty.ptmx_max'],
      timeoutMs: 1_000,
      maxOutputBytes: 1024
    })
    return result.code === 0 && !result.timedOut && !result.outputTruncated
      ? positiveInteger(result.stdout)
      : null
  }
  if (process.platform === 'linux') {
    const [global, mounts] = await Promise.all([
      readNodeFileWithinLimit('/proc/sys/kernel/pty/max', 1024),
      readNodeFileWithinLimit('/proc/self/mounts', 1024 * 1024)
    ])
    return parseLinuxPtyLimit(global.buffer.toString('utf8'), mounts.buffer.toString('utf8'))
  }
  return null
}

/** A stuck filesystem probe stays coalesced; caller deadlines never create more outstanding I/O. */
export class SystemPtyLimit {
  private readonly pending = new InFlightPromiseDedupe<number | null>(0, 1)
  constructor(private readonly probe: () => Promise<number | null> = probeSystemPtyLimit) {}

  async read(): Promise<number | null> {
    const result = await awaitDaemonValueWithinCallerDeadline(
      this.pending.run('system', () => this.probe().catch(() => null)),
      Date.now() + 1_100
    )
    return result.completed ? result.value : null
  }
}
