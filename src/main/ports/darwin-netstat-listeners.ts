import { isIP } from 'node:net'
import { getProcessOutputFields } from '../../shared/process-output-field-scanner'
import { dedupeRawPorts } from './local-workspace-port-address'
import type { RawListeningPort } from './local-workspace-port-scan-state'

const MAX_RETAINED_CHARS = 2 * 1024 * 1024
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
    const fields = getProcessOutputFields(line, 9)
    if (!this.title && line === 'Active Internet connections (including servers)') {
      this.title = true
    } else if (
      this.title &&
      !this.header &&
      fields.join(' ') === 'Proto Recv-Q Send-Q Local Address Foreign Address (state)'
    ) {
      this.header = true
    } else if (
      this.header &&
      fields.length === 6 &&
      /^tcp(?:4|6|46)$/.test(fields[0]) &&
      /^\d+$/.test(fields[1]) &&
      /^\d+$/.test(fields[2]) &&
      STATES.has(fields[5])
    ) {
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

export function parseDarwinNetstatListeners(output: string): RawListeningPort[] {
  const parser = new DarwinNetstatListeners()
  parser.write(output)
  const ports: RawListeningPort[] = []
  for (const line of parser.finish().split('\n')) {
    const fields = getProcessOutputFields(line, 6)
    if (fields[5] === 'LISTEN') {
      const port = endpoint(fields[3])
      if (port) {
        ports.push(port)
      }
    }
  }
  return dedupeRawPorts(ports)
}
