import { readFile, readdir, readlink } from 'fs/promises'
import type { RelayDispatcher } from './dispatcher'

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
    dispatcher.onRequest('ports.detect', async () => {
      if (process.platform !== 'linux') {
        return { ports: [], platform: process.platform }
      }
      return {
        ports: await this.scanListeningPorts(),
        platform: process.platform
      }
    })
  }

  private async scanListeningPorts(): Promise<DetectedPort[]> {
    const [tcp4, tcp6] = await Promise.all([
      this.readProcNet('/proc/net/tcp'),
      this.readProcNet('/proc/net/tcp6')
    ])

    const listeningSockets = [...tcp4, ...tcp6]
    if (listeningSockets.length === 0) {
      return []
    }

    const inodeSet = new Set(listeningSockets.map((s) => s.inode))
    const inodeToPid = await this.mapInodesToPids(inodeSet)

    const seen = new Set<string>()
    const results: DetectedPort[] = []
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

      const processName = pid != null ? await this.getProcessName(pid) : undefined

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
    let content: string
    try {
      content = await readFile(path, 'utf-8')
    } catch {
      return []
    }

    const lines = content.split('\n')
    const results: { port: number; host: string; inode: number }[] = []

    for (let i = 1; i < lines.length; i++) {
      const fields = lines[i].trim().split(/\s+/)
      if (fields.length < 10) {
        continue
      }

      // State field (index 3): 0A = TCP_LISTEN
      if (fields[3] !== '0A') {
        continue
      }

      const localAddress = fields[1]
      const parsed = parseHexAddress(localAddress)
      if (!parsed) {
        continue
      }

      const inode = parseInt(fields[9], 10)
      if (isNaN(inode) || inode === 0) {
        continue
      }

      results.push({ port: parsed.port, host: parsed.host, inode })
    }

    return results
  }

  private async mapInodesToPids(inodes: Set<number>): Promise<Map<number, number>> {
    const result = new Map<number, number>()
    if (inodes.size === 0) {
      return result
    }

    let pids: string[]
    try {
      pids = (await readdir('/proc')).filter((name) => /^\d+$/.test(name))
    } catch {
      return result
    }

    for (const pidStr of pids) {
      const fdDir = `/proc/${pidStr}/fd`
      let fds: string[]
      try {
        fds = await readdir(fdDir)
      } catch {
        continue
      }

      const pid = parseInt(pidStr, 10)

      for (const fd of fds) {
        let link: string
        try {
          link = await readlink(`${fdDir}/${fd}`)
        } catch {
          continue
        }

        const match = link.match(/^socket:\[(\d+)\]$/)
        if (!match) {
          continue
        }

        const inode = parseInt(match[1], 10)
        if (inodes.has(inode)) {
          result.set(inode, pid)
        }
      }
    }

    return result
  }

  private async getProcessName(pid: number): Promise<string | undefined> {
    try {
      const cmdline = await readFile(`/proc/${pid}/cmdline`, 'utf-8')
      if (!cmdline) {
        return undefined
      }

      const exe = cmdline.split('\0')[0]
      if (!exe) {
        return undefined
      }

      const parts = exe.split('/')
      return parts.at(-1)
    } catch {
      return undefined
    }
  }
}

// Why: /proc/net/tcp encodes addresses as hex pairs in host-byte-order.
// IPv4: 8 hex chars for address + ':' + 4 hex chars for port.
// IPv6: 32 hex chars for address + ':' + 4 hex chars for port.
export function parseHexAddress(hexAddr: string): { host: string; port: number } | null {
  const parts = hexAddr.split(':')
  if (parts.length !== 2) {
    return null
  }

  const port = parseInt(parts[1], 16)
  if (isNaN(port) || port === 0) {
    return null
  }

  const addrHex = parts[0]

  if (addrHex.length === 8) {
    const b1 = parseInt(addrHex.substring(6, 8), 16)
    const b2 = parseInt(addrHex.substring(4, 6), 16)
    const b3 = parseInt(addrHex.substring(2, 4), 16)
    const b4 = parseInt(addrHex.substring(0, 2), 16)
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
