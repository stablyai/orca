import { isIP } from 'node:net'
import { getProcessOutputFields } from '../../shared/process-observation/process-output-field-scanner'
import { dedupeRawPorts } from './local-workspace-port-address'
import type { RawListeningPort } from './local-workspace-port-scan-state'

const MAX_RETAINED_CHARS = 2 * 1024 * 1024
const HEADER = 'Proto Recv-Q Send-Q Local Address Foreign Address (state)'
// `netstat -A` prefixes each row with the socket's kernel address (and Flowhash on newer macOS).
const SOCKET_HEADERS = new Map([
  [HEADER, 0],
  [`Socket ${HEADER}`, 1],
  [`Socket Flowhash ${HEADER}`, 2]
])
const STATES = new Set([
  'CLOSED',
  'LISTEN',
  'SYN_SENT',
  'SYN_RCVD',
  'ESTABLISHED',
  'CLOSE_WAIT',
  'FIN_WAIT_1',
  'CLOSING',
  'LAST_ACK',
  'FIN_WAIT_2',
  'TIME_WAIT'
])

function endpoint(text: string): RawListeningPort | null {
  const delimiter = text.lastIndexOf('.')
  const host = text.slice(0, delimiter)
  const portText = text.slice(delimiter + 1)
  const port = Number(portText)
  if (
    delimiter < 1 ||
    !/^\d+$/.test(portText) ||
    port < 1 ||
    port > 65535 ||
    (host !== '*' && isIP(host) === 0)
  ) {
    throw new Error('Incomplete port listener address.')
  }
  // Long-mode netstat truncates scoped IPv6 text at 39 characters.
  return host.includes('%') && host.length === 39 ? null : { host, port }
}

/** Drain all TCP rows, retaining only complete headers/listeners and a bounded partial line. */
export class DarwinNetstatListeners {
  private pending = ''
  private title = false
  private header = false
  private retained = ''
  /** Leading socket-identity columns before Proto: 0 without `-A`. */
  socketColumns = 0

  write(chunk: string): void {
    this.pending += chunk
    let newline: number
    while ((newline = this.pending.indexOf('\n')) !== -1) {
      const line = this.pending.slice(0, newline).trim()
      this.pending = this.pending.slice(newline + 1)
      if (line.length > 4096) {
        throw new Error('Incomplete port listener output.')
      }
      this.line(line)
    }
    if (this.pending.length > 4096) {
      throw new Error('Incomplete port listener output.')
    }
  }

  finish(): string {
    // The system prints headers only after encountering its first TCP PCB.
    if (!this.pending && !this.title && !this.header) {
      return ''
    }
    if (this.pending || !this.title || !this.header) {
      throw new Error('Incomplete port listener output.')
    }
    return this.retained
  }

  private line(line: string): void {
    if (!line) {
      return
    }
    if (!this.title && line === 'Active Internet connections (including servers)') {
      this.title = true
    } else if (
      this.title &&
      !this.header &&
      SOCKET_HEADERS.has(getProcessOutputFields(line, 11).join(' '))
    ) {
      this.header = true
      this.socketColumns = SOCKET_HEADERS.get(getProcessOutputFields(line, 11).join(' ')) ?? 0
    } else if (this.header && isTcpRow(getProcessOutputFields(line, 9), this.socketColumns)) {
      const fields = getProcessOutputFields(line, 9).slice(this.socketColumns)
      if (fields[5] !== 'LISTEN' || !endpoint(fields[3])) {
        return
      }
    } else {
      throw new Error('Unrecognized port listener output.')
    }
    if (this.retained.length + line.length + 1 > MAX_RETAINED_CHARS) {
      throw new Error('Port listener output is too large.')
    }
    this.retained += `${line}\n`
  }
}

function isTcpRow(fields: string[], socketColumns: number): boolean {
  const row = fields.slice(socketColumns)
  return (
    fields.length === 6 + socketColumns &&
    fields.slice(0, socketColumns).every((field) => /^[0-9a-f]+$/i.test(field)) &&
    /^tcp(?:4|6|46)$/.test(row[0]) &&
    /^\d+$/.test(row[1]) &&
    /^\d+$/.test(row[2]) &&
    STATES.has(row[5])
  )
}

export function parseDarwinNetstatListeners(output: string): RawListeningPort[] {
  return readDarwinNetstatListeners(output).ports
}

/** Ports plus a signature of each LISTEN socket's kernel identity and address; null without `-A` columns. */
export function readDarwinNetstatListeners(output: string): {
  ports: RawListeningPort[]
  socketSignature: string | null
} {
  const parser = new DarwinNetstatListeners()
  parser.write(output)
  const ports: RawListeningPort[] = []
  const sockets: string[] = []
  const lines = parser.finish().split('\n')
  for (const line of lines) {
    const all = getProcessOutputFields(line, 6 + parser.socketColumns)
    const fields = all.slice(parser.socketColumns)
    if (fields[5] === 'LISTEN') {
      if (parser.socketColumns > 0) {
        sockets.push(`${all[0].toLowerCase()} ${fields[3]}`)
      }
      const port = endpoint(fields[3])
      if (port) {
        ports.push(port)
      }
    }
  }
  return {
    ports: dedupeRawPorts(ports),
    socketSignature: parser.socketColumns > 0 ? sockets.sort().join('\n') : null
  }
}
