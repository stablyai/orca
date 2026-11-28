import {
  getProcessOutputFields,
  iterateProcessOutputLines
} from '../../shared/process-observation/process-output-field-scanner'
import { parseProcAddress } from './local-workspace-port-address'

/** One /proc/net/tcp{,6} row; addresses stay in the kernel's hex `ADDR:PORT` form. */
export type ProcNetTcpRow = {
  localAddress: string
  remoteAddress: string
  state: string
  uid: number
  inode: number
}

export const PROC_NET_TCP_LISTEN_STATE = '0A'

export function parseProcNetTcpRows(content: string): ProcNetTcpRow[] {
  const rows: ProcNetTcpRow[] = []
  let isHeader = true
  for (const line of iterateProcessOutputLines(content)) {
    if (isHeader) {
      isHeader = false
      continue
    }
    const row = parseProcNetTcpRow(line)
    if (row) {
      rows.push(row)
    }
  }
  return rows
}

export function parseProcNetTcpRow(line: string): ProcNetTcpRow | null {
  const fields = getProcessOutputFields(line, 10)
  if (fields.length < 10) {
    return null
  }
  const uid = Number.parseInt(fields[7], 10)
  const inode = Number.parseInt(fields[9], 10)
  if (!Number.isFinite(uid) || !Number.isFinite(inode)) {
    return null
  }
  return { localAddress: fields[1], remoteAddress: fields[2], state: fields[3], uid, inode }
}

const IPV4_MAPPED_IPV6_PREFIX = '0000000000000000FFFF0000'

/** Decodes a row address; IPv4-mapped IPv6 (dual-stack sockets in tcp6) comes back as dotted IPv4. */
export function parseProcNetTcpEndpoint(hexAddress: string): { host: string; port: number } | null {
  const [addrHex = '', portHex = ''] = hexAddress.split(':')
  if (addrHex.length === 32 && addrHex.toUpperCase().startsWith(IPV4_MAPPED_IPV6_PREFIX)) {
    return parseProcAddress(`${addrHex.slice(24)}:${portHex}`)
  }
  return parseProcAddress(hexAddress)
}
