import { readFile, readdir, readlink } from 'node:fs/promises'
import { getProcessOutputFields } from '../shared/process-output-field-scanner'
import type { RelayDispatcher, RequestContext } from './dispatcher'
import { scanWindowsListeningPorts } from './windows-port-scan'

// Keep in sync with src/shared/ssh-types.ts — DetectedPort
export type DetectedPort = {
  port: number
  host: string
  pid?: number
  processName?: string
  uid?: number
  username?: string
  ownedByConnectingUser?: boolean
}

type ProcNetSocket = {
  port: number
  host: string
  inode: number
  /** Absent when /proc uid field is malformed — port still surfaces without ownership. */
  uid?: number
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
    const [tcp4, tcp6, uidUsernames] = await Promise.all([
      this.readProcNet('/proc/net/tcp'),
      this.readProcNet('/proc/net/tcp6'),
      this.loadUidUsernameMap()
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
    const connectingUid = typeof process.getuid === 'function' ? process.getuid() : undefined

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

      const ownership = ownershipFieldsForSocket(socket.uid, connectingUid, uidUsernames)
      results.push({
        port: socket.port,
        host: socket.host,
        pid: pid ?? undefined,
        processName,
        ...ownership
      })
    }

    // Why: sort before capping so the visible set is deterministic (lowest
    // port numbers first) regardless of /proc enumeration order.
    results.sort((a, b) => a.port - b.port)
    return results.slice(0, MAX_DETECTED_PORTS)
  }

  private async readProcNet(path: string): Promise<ProcNetSocket[]> {
    let content: string
    try {
      content = await readFile(path, 'utf-8')
    } catch {
      return []
    }
    return parseProcNetListeningSockets(content)
  }

  private async loadUidUsernameMap(): Promise<Map<number, string>> {
    try {
      return parsePasswdUidUsernames(await readFile('/etc/passwd', 'utf-8'))
    } catch {
      return new Map()
    }
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

      const pid = Number.parseInt(pidStr, 10)

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

        const inode = Number.parseInt(match[1], 10)
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

/** Parse /proc/net/tcp(6) listen rows including owner uid (field index 7). */
export function parseProcNetListeningSockets(content: string): ProcNetSocket[] {
  const lines = content.split('\n')
  const results: ProcNetSocket[] = []

  for (let i = 1; i < lines.length; i++) {
    // Why: need through inode (index 9); uid is index 7 on the standard table.
    const fields = getProcessOutputFields(lines[i], 10)
    if (fields.length < 10) {
      continue
    }

    // State field (index 3): 0A = TCP_LISTEN
    if (fields[3] !== '0A') {
      continue
    }

    const parsed = parseHexAddress(fields[1])
    if (!parsed) {
      continue
    }

    const inode = Number.parseInt(fields[9], 10)
    if (Number.isNaN(inode) || inode === 0) {
      continue
    }

    // Why: degrade uid like pid — keep the listen row when ownership metadata is unparseable.
    const parsedUid = Number.parseInt(fields[7], 10)
    const uid = Number.isNaN(parsedUid) || parsedUid < 0 ? undefined : parsedUid

    results.push({ port: parsed.port, host: parsed.host, inode, uid })
  }

  return results
}

/** Map uid → username from /etc/passwd contents. */
export function parsePasswdUidUsernames(content: string): Map<number, string> {
  const map = new Map<number, string>()
  for (const line of content.split('\n')) {
    if (!line || line.startsWith('#')) {
      continue
    }
    const parts = line.split(':')
    if (parts.length < 3) {
      continue
    }
    const username = parts[0]
    const uid = Number.parseInt(parts[2], 10)
    if (!username || Number.isNaN(uid) || uid < 0) {
      continue
    }
    map.set(uid, username)
  }
  return map
}

export function resolveUsernameForUid(uid: number, uidUsernames: Map<number, string>): string {
  return uidUsernames.get(uid) ?? String(uid)
}

export function ownershipFieldsForSocket(
  uid: number | undefined,
  connectingUid: number | undefined,
  uidUsernames: Map<number, string>
): Pick<DetectedPort, 'uid' | 'username' | 'ownedByConnectingUser'> {
  if (uid === undefined) {
    return {}
  }
  return {
    uid,
    username: resolveUsernameForUid(uid, uidUsernames),
    ...(connectingUid !== undefined ? { ownedByConnectingUser: uid === connectingUid } : {})
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
