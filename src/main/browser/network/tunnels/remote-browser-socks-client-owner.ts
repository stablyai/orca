import { readFile } from 'node:fs/promises'
import type { Socket } from 'node:net'
import { parseProcNetTcpEndpoint, parseProcNetTcpRow } from '../../../ports/linux-proc-net-tcp-rows'

export type SocksClientOwnerVerdict =
  | { allowed: true }
  | { allowed: false; reason: 'foreign-owner'; uid: number }
  | { allowed: false; reason: 'lookup-failed'; detail: string }

type Endpoint = { host: string; port: number }
type AcceptedSocket = {
  localAddress?: string
  localPort?: number
  remoteAddress?: string
  remotePort?: number
}

type Refusal = Exclude<SocksClientOwnerVerdict, { allowed: true }>

/** Admits a loopback client once its owner checks out. Chromium can't authenticate to SOCKS, so the owner is the only credential. */
export function createSocksClientAdmission(): (socket: Socket, admit: () => void) => void {
  const logged = new Set<string>()
  const logOnce = (refusal: Refusal): void => {
    const key = refusal.reason === 'foreign-owner' ? `uid:${refusal.uid}` : refusal.reason
    if (logged.has(key)) {
      return
    }
    logged.add(key)
    console.warn(
      refusal.reason === 'foreign-owner'
        ? `[browser-tunnel] Refused a browser SOCKS connection from uid ${refusal.uid}; only this user's browser may use it.`
        : `[browser-tunnel] Refused a browser SOCKS connection: could not confirm its owner in /proc/net (${refusal.detail}).`
    )
  }
  return (socket, admit) => {
    if (!isLoopbackAddress(socket.remoteAddress)) {
      socket.destroy()
      return
    }
    void verifySocksClientOwner(socket).then((verdict) => {
      if (socket.destroyed) {
        return
      }
      if (verdict.allowed) {
        admit()
        return
      }
      logOnce(verdict)
      socket.destroy()
    })
  }
}

/** Uid of the socket whose local end is `client` and remote end is `listener`: the connecting side, not our accepted copy. */
export function findProcNetTcpClientUid(
  table: string,
  client: Endpoint,
  listener: Endpoint
): number | null {
  // Shared hosts list thousands of sockets; a native regex scan finds the candidate lines without walking every row.
  const candidates = new RegExp(
    `^ *\\d+: [0-9A-F]+:${toPortHex(client.port)} [0-9A-F]+:${toPortHex(listener.port)} .*$`,
    'gm'
  )
  for (const [line] of table.matchAll(candidates)) {
    const row = parseProcNetTcpRow(line)
    // Inode 0 is a TIME_WAIT or orphaned socket that no process holds any more.
    if (!row || row.inode === 0) {
      continue
    }
    const local = parseProcNetTcpEndpoint(row.localAddress)
    const remote = parseProcNetTcpEndpoint(row.remoteAddress)
    if (
      local?.port === client.port &&
      local.host === client.host &&
      remote?.port === listener.port &&
      remote.host === listener.host
    ) {
      return row.uid
    }
  }
  return null
}

/** Linux lists every user's sockets with their owner; the client end must be ours. Other platforms rely on the loopback check. */
export async function verifySocksClientOwner(
  socket: AcceptedSocket,
  readTable: (path: string) => Promise<string> = (path) => readFile(path, 'utf-8')
): Promise<SocksClientOwnerVerdict> {
  const ownUid = process.platform === 'linux' ? process.getuid?.() : undefined
  if (ownUid === undefined) {
    return { allowed: true }
  }
  const client = toEndpoint(socket.remoteAddress, socket.remotePort)
  const listener = toEndpoint(socket.localAddress, socket.localPort)
  if (!client || !listener) {
    return { allowed: false, reason: 'lookup-failed', detail: 'socket has no address' }
  }
  try {
    // The kernel pages these tables and can skip a row that moved mid-read, so look twice before refusing.
    for (let attempt = 0; attempt < 2; attempt++) {
      // A 4-tuple is unique across both tables; dual-stack clients appear in tcp6 as v4-mapped.
      for (const path of ['/proc/net/tcp', '/proc/net/tcp6']) {
        const uid = findProcNetTcpClientUid(await readTable(path), client, listener)
        if (uid !== null) {
          return uid === ownUid
            ? { allowed: true }
            : { allowed: false, reason: 'foreign-owner', uid }
        }
      }
    }
    return { allowed: false, reason: 'lookup-failed', detail: 'client socket not listed' }
  } catch (error) {
    return {
      allowed: false,
      reason: 'lookup-failed',
      detail: error instanceof Error ? error.message : String(error)
    }
  }
}

function toEndpoint(address: string | undefined, port: number | undefined): Endpoint | null {
  if (!address || !port) {
    return null
  }
  // The listener binds IPv4 only, so Node reports both ends as IPv4 (maybe v4-mapped).
  const host = address.toLowerCase().startsWith('::ffff:') ? address.slice(7) : address
  return { host, port }
}

function toPortHex(port: number): string {
  return port.toString(16).toUpperCase().padStart(4, '0')
}

function isLoopbackAddress(address: string | undefined): boolean {
  return (
    address === '::1' ||
    address?.startsWith('127.') === true ||
    address?.toLowerCase().startsWith('::ffff:127.') === true
  )
}
