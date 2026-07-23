import { getProcessOutputFields } from '../shared/process-output-field-scanner'
import { mapLinuxSocketInodesToPids } from '../shared/linux-proc-socket-owner-scanner'
import {
  createLinuxProcTextReadBudget,
  LINUX_PROC_LISTENING_SOCKET_MAX_ENTRIES,
  readLinuxProcNetworkTable,
  readLinuxProcTextWithinBudget,
  type LinuxProcTextReadBudget
} from '../shared/linux-proc-port-scan-limits'
import type { RelayDispatcher, RequestContext } from './dispatcher'
import { scanWindowsListeningPorts } from './windows-port-scan'

// Keep in sync with src/shared/ssh-types.ts — DetectedPort
export type DetectedPort = {
  port: number
  host: string
  pid?: number
  processName?: string
}

const SYSTEM_PORTS_TO_EXCLUDE = new Set([22])

const MAX_DETECTED_PORTS = 50

export class PortScanHandler {
  constructor(dispatcher: RelayDispatcher) {
    dispatcher.onRequest('ports.detect', async (_params, context: RequestContext) => {
      if (process.platform === 'linux') {
        return {
          ports: await this.scanLinuxListeningPorts(),
          platform: process.platform
        }
      }
      if (process.platform === 'win32') {
        return {
          ports: await scanWindowsListeningPorts(context.signal),
          platform: process.platform
        }
      }
      return {
        ports: [],
        platform: process.platform
      }
    })
  }

  private async scanLinuxListeningPorts(): Promise<DetectedPort[]> {
    const [tcp4, tcp6] = await Promise.all([
      this.readProcNet('/proc/net/tcp'),
      this.readProcNet('/proc/net/tcp6')
    ])

    const listeningSockets = [...tcp4, ...tcp6].slice(0, LINUX_PROC_LISTENING_SOCKET_MAX_ENTRIES)
    if (listeningSockets.length === 0) {
      return []
    }

    const inodeSet = new Set(listeningSockets.map((s) => s.inode))
    const inodeToPid = await mapLinuxSocketInodesToPids(inodeSet)

    const seen = new Set<string>()
    const results: DetectedPort[] = []
    const metadataBudget = createLinuxProcTextReadBudget()
    const relayPid = process.pid
    const relayParentPid = process.ppid

    for (const socket of listeningSockets) {
      const key = `${socket.host}:${socket.port}`
      if (seen.has(key)) {
        continue
      }
      seen.add(key)

      if (SYSTEM_PORTS_TO_EXCLUDE.has(socket.port)) {
        continue
      }

      const pid = inodeToPid.get(socket.inode)
      if (pid === relayPid || pid === relayParentPid) {
        continue
      }

      const processName = pid != null ? await this.getProcessName(pid, metadataBudget) : undefined

      if (processName === 'sshd') {
        continue
      }

      results.push({
        port: socket.port,
        host: socket.host,
        pid: pid ?? undefined,
        processName
      })
    }

    // Why: sort before capping so the visible set is deterministic (lowest
    // port numbers first) regardless of /proc enumeration order.
    results.sort((a, b) => a.port - b.port)
    return results.slice(0, MAX_DETECTED_PORTS)
  }

  private async readProcNet(
    path: string
  ): Promise<{ port: number; host: string; inode: number }[]> {
    const content = await readLinuxProcNetworkTable(path)
    return content === null ? [] : parseLinuxProcListeningSockets(content)
  }

  private async getProcessName(
    pid: number,
    budget: LinuxProcTextReadBudget
  ): Promise<string | undefined> {
    const cmdline = await readLinuxProcTextWithinBudget(`/proc/${pid}/cmdline`, budget)
    if (!cmdline) {
      return undefined
    }

    const exe = cmdline.split('\0')[0]
    return exe ? exe.split('/').at(-1) : undefined
  }
}

export function parseLinuxProcListeningSockets(
  content: string
): { port: number; host: string; inode: number }[] {
  const lines = content.split('\n')
  const results: { port: number; host: string; inode: number }[] = []

  for (let i = 1; i < lines.length; i++) {
    const fields = getProcessOutputFields(lines[i], 10)
    if (fields.length < 10 || fields[3] !== '0A') {
      continue
    }
    const parsed = parseHexAddress(fields[1])
    const inode = Number.parseInt(fields[9], 10)
    if (!parsed || !Number.isFinite(inode) || inode === 0) {
      continue
    }
    results.push({ port: parsed.port, host: parsed.host, inode })
    if (results.length >= LINUX_PROC_LISTENING_SOCKET_MAX_ENTRIES) {
      break
    }
  }

  return results
}

// Why: /proc/net/tcp encodes addresses as hex pairs in host-byte-order.
// IPv4: 8 hex chars for address + ':' + 4 hex chars for port.
// IPv6: 32 hex chars for address + ':' + 4 hex chars for port.
export function parseHexAddress(hexAddr: string): { host: string; port: number } | null {
  const parts = hexAddr.split(':')
  if (parts.length !== 2) {
    return null
  }

  const port = Number.parseInt(parts[1], 16)
  if (Number.isNaN(port) || port === 0) {
    return null
  }

  const addrHex = parts[0]

  if (addrHex.length === 8) {
    const b1 = Number.parseInt(addrHex.substring(6, 8), 16)
    const b2 = Number.parseInt(addrHex.substring(4, 6), 16)
    const b3 = Number.parseInt(addrHex.substring(2, 4), 16)
    const b4 = Number.parseInt(addrHex.substring(0, 2), 16)
    const host = `${b1}.${b2}.${b3}.${b4}`
    return { host, port }
  }

  if (addrHex.length === 32) {
    if (addrHex === '00000000000000000000000000000000') {
      return { host: '::', port }
    }
    if (addrHex === '00000000000000000000000001000000') {
      return { host: '::1', port }
    }
    return { host: formatIPv6(addrHex), port }
  }

  return null
}

function formatIPv6(hex: string): string {
  const groups: string[] = []
  for (let i = 0; i < 32; i += 8) {
    const chunk = hex.substring(i, i + 8)
    const reversed =
      chunk.substring(6, 8) + chunk.substring(4, 6) + chunk.substring(2, 4) + chunk.substring(0, 2)
    groups.push(reversed.substring(0, 4))
    groups.push(reversed.substring(4, 8))
  }
  return groups.map((g) => g.replace(/^0+/, '') || '0').join(':')
}
