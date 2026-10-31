import { PROVIDER_SPAWN_FAILURE_MARKER } from './provider-spawn-failure-report'
import { detachProviderStreamErrorHandler } from './provider-stdio-error-boundary'
import { Duplex } from 'node:stream'
import { createIncrementalNdjsonFramer } from '../../shared/main-process-ndjson-framer'
import type { ProviderSpawnAbsence } from './provider-executable-missing'

export type ProviderLaunchRecord =
  | { kind: 'spawned'; pgid: number }
  | { kind: 'failed'; thrown: boolean; error: NodeJS.ErrnoException }

export type ProviderLaunchObservation = {
  record: ProviderLaunchRecord | null
  absence: ProviderSpawnAbsence | null
  directError: unknown
}

export type ProviderLaunchReport = {
  readonly record: ProviderLaunchRecord | null
  readonly done: Promise<ProviderLaunchRecord | null>
  readonly closed: Promise<void>
  subscribe: (listener: (record: ProviderLaunchRecord) => void) => () => void
  abandon: () => void
  retire: () => void
}

function launchRecord(value: unknown): ProviderLaunchRecord | null {
  if (!value || typeof value !== 'object' || !('kind' in value)) {
    return null
  }
  if (
    value.kind === 'spawned' &&
    'pgid' in value &&
    typeof value.pgid === 'number' &&
    Number.isSafeInteger(value.pgid) &&
    value.pgid > 1
  ) {
    return { kind: 'spawned', pgid: value.pgid }
  }
  if (
    value.kind !== 'failed' ||
    !('thrown' in value) ||
    typeof value.thrown !== 'boolean' ||
    !('error' in value)
  ) {
    return null
  }
  const fields = value.error
  if (
    !fields ||
    typeof fields !== 'object' ||
    !('message' in fields) ||
    typeof fields.message !== 'string'
  ) {
    return null
  }
  const error: NodeJS.ErrnoException = new Error(fields.message)
  for (const key of ['name', 'code', 'syscall', 'path', 'stack'] as const) {
    if (key in fields) {
      const field = fields[key]
      if (typeof field !== 'string') {
        return null
      }
      Object.assign(error, { [key]: field })
    }
  }
  if ('errno' in fields) {
    if (typeof fields.errno !== 'number') {
      return null
    }
    error.errno = fields.errno
  }
  return { kind: 'failed', thrown: value.thrown, error }
}

/** This owner retains launch receipt/ACK even after every semantic subscriber has retired. */
export function createProviderLaunchReport(
  child: {
    stdio?: readonly unknown[]
    once: (event: 'exit', listener: () => void) => unknown
    removeListener: (event: 'exit', listener: () => void) => unknown
  },
  supervised: boolean
): ProviderLaunchReport {
  const stream = supervised && child.stdio?.[3] instanceof Duplex ? child.stdio[3] : null
  const delivery = Promise.withResolvers<ProviderLaunchRecord | null>()
  const closed = Promise.withResolvers<void>()
  const listeners = new Set<(record: ProviderLaunchRecord) => void>()
  let record: ProviderLaunchRecord | null = null
  let retired = false
  let draining = false
  const transfer = (): void => {
    if (!stream || draining) {
      return
    }
    draining = true
    stream.pause()
    stream.removeListener('data', data)
    try {
      for (let chunk = stream.read(); chunk !== null; chunk = stream.read()) {
        framer.feed(String(chunk))
      }
      framer.drain()
    } finally {
      draining = false
      if (!retired) {
        stream.on('data', data).resume()
      }
    }
  }
  const retire = (): void => {
    if (retired) {
      return
    }
    transfer()
    retired = true
    framer.finish(false)
    delivery.resolve(record)
    listeners.clear()
    child.removeListener('exit', retire)
    if (stream) {
      stream.removeListener('data', data)
      stream.removeListener('end', retire)
      stream.removeListener('close', retire)
      detachProviderStreamErrorHandler(stream, retire)
      if (stream.closed) {
        closed.resolve()
      } else {
        stream.once('close', () => closed.resolve())
      }
      stream.destroy()
    } else {
      closed.resolve()
    }
  }
  const framer = createIncrementalNdjsonFramer((value) => {
    if (retired) {
      return
    }
    const next = launchRecord(value)
    if (!next || record) {
      retire()
      return
    }
    record = next
    // Commit before ACK or subscribers; write backpressure cannot refuse this fact.
    delivery.resolve(record)
    const notify = [...listeners]
    listeners.clear()
    try {
      stream?.write('{"kind":"committed"}\n', (error) => {
        if (error) {
          retire()
        }
      })
    } catch {
      retire()
    }
    for (const listener of notify) {
      listener(record)
    }
  }, retire)
  const data = (chunk: string): void => framer.feed(chunk)
  if (stream) {
    stream.setEncoding('utf8').on('data', data)
    stream.once('end', retire)
    stream.once('close', retire)
    stream.on('error', retire)
    child.once('exit', retire)
  } else {
    delivery.resolve(null)
    closed.resolve()
  }
  return {
    get record() {
      return record
    },
    done: delivery.promise,
    closed: closed.promise,
    subscribe: (listener) => {
      if (record) {
        listener(record)
      } else if (!retired && stream) {
        listeners.add(listener)
      }
      return () => {
        listeners.delete(listener)
      }
    },
    abandon: () => {
      transfer()
      delivery.resolve(record)
    },
    retire
  }
}

/** Same-build supervisor endpoint for the owned report pipe. */
export const PROVIDER_LAUNCH_REPORT_SCRIPT = `
// Only the supervisor holds fd3; the provider receives /dev/null in that slot.
const { Socket } = require('node:net')
let report
try { report = new Socket({ fd: 3, readable: true, writable: true }) } catch {}
const reportShield = report ? require('node:fs').openSync('/dev/null', 'r') : null
let releaseReport
const reportCommitted = new Promise((resolve) => { releaseReport = resolve })
if (report) {
  report.setEncoding('utf8')
  let ack = ''
  report.on('data', (chunk) => { ack += chunk; if (ack.includes('\\n')) { releaseReport(); report.destroy() } })
  report.on('end', releaseReport)
  report.on('close', releaseReport)
  report.on('error', () => { releaseReport(); report.destroy() })
} else releaseReport()
const sendReport = (value) => {
  try { report?.write(JSON.stringify(value) + '\\n') } catch { releaseReport(); report?.destroy() }
}
const exitWithSpawnFailure = async (error, thrown) => {
  const fields = {}
  for (const key of ['name', 'message', 'code', 'errno', 'syscall', 'path', 'stack']) {
    if (error && error[key] !== undefined) fields[key] = error[key]
  }
  fields.message = String(error && error.message)
  sendReport({ kind: 'failed', thrown, error: fields })
  await reportCommitted
  try { require('node:fs').writeSync(2, ${JSON.stringify(PROVIDER_SPAWN_FAILURE_MARKER)} + JSON.stringify({ thrown, code: fields.code || 'UNKNOWN', message: fields.message }) + '\\n') } catch {}
  process.exit(127)
}
`
