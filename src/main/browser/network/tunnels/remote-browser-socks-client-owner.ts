import { readFile } from 'node:fs/promises'
import type { Socket } from 'node:net'
import { app } from 'electron'
import { parseProcNetTcpEndpoint, parseProcNetTcpRow } from '../../../ports/linux-proc-net-tcp-rows'
import {
  darwinSocketOwnerHelperAvailable,
  isOwnDarwinConnection,
  retainDarwinSocketOwnerHelper
} from './darwin-socket-owner-helper'
import {
  loadWindowsSecurityAsync,
  type WindowsSecurity
} from '../../../../shared/secure-storage/windows-security-addon'

export type SocksClientOwnerVerdict =
  /** `unreadableOwnProcess`: the owner is one of this app's processes, but its account couldn't be read. */
  | { allowed: true; unreadableOwnProcess?: string }
  /** `owner` is `uid <n>` on Linux and the token user's SID on Windows. */
  | { allowed: false; reason: 'foreign-owner'; owner: string }
  | { allowed: false; reason: 'lookup-failed'; detail: string }

type Endpoint = { host: string; port: number }
type AcceptedSocket = {
  localAddress?: string
  localPort?: number
  remoteAddress?: string
  remotePort?: number
}

/** Admits a loopback client once its owner checks out. Chromium can't authenticate to SOCKS, so the owner is the only credential. */
export function createSocksClientAdmission(
  /** Names the listener in logs, e.g. a port forward. */
  listener = 'browser SOCKS'
): (socket: Socket, admit: () => void) => void {
  const logged = new Set<string>()
  const logOnce = (verdict: SocksClientOwnerVerdict): void => {
    const key = verdict.allowed
      ? 'unreadable-own-process'
      : verdict.reason === 'foreign-owner'
        ? `owner:${verdict.owner}`
        : verdict.reason
    if (logged.has(key)) {
      return
    }
    logged.add(key)
    console.warn(
      verdict.allowed
        ? `[browser-tunnel] Admitted a ${listener} connection from this app's own process whose account could not be read (${verdict.unreadableOwnProcess}).`
        : verdict.reason === 'foreign-owner'
          ? `[browser-tunnel] Refused a ${listener} connection from ${verdict.owner}; only this user may use it.`
          : `[browser-tunnel] Refused a ${listener} connection: could not confirm its owner (${verdict.detail}).`
    )
  }
  return (socket, admit) => {
    if (!isLoopbackAddress(socket.remoteAddress)) {
      socket.destroy()
      return
    }
    const departure = process.platform === 'darwin' ? watchClientDeparture(socket) : undefined
    void verifySocksClientOwner(socket, undefined, departure?.signal).then((verdict) => {
      departure?.stop()
      if (socket.destroyed) {
        return
      }
      // Its lookup was dropped because the client left; nothing to report.
      if (!verdict.allowed && departure?.signal.aborted) {
        socket.destroy()
        return
      }
      if (!verdict.allowed || verdict.unreadableOwnProcess) {
        logOnce(verdict)
      }
      if (verdict.allowed) {
        admit()
        return
      }
      socket.destroy()
    })
  }
}

/** macOS lookups queue behind one helper, so one for a client that already left is dropped unscanned.
 *  A half-close is not a close: forwards stay half-open, and the client may still be reading. */
function watchClientDeparture(socket: Socket): { signal: AbortSignal; stop: () => void } {
  const departed = new AbortController()
  const abort = (): void => departed.abort()
  socket.once('close', abort)
  // A pauseOnConnect socket doesn't notice a reset until it reads; bytes stay buffered.
  socket.read(0)
  return { signal: departed.signal, stop: () => socket.off('close', abort) }
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

/** How this computer names a loopback client's account. */
type OwnerLookup =
  | { kind: 'darwin' }
  | { kind: 'uid'; uid: number }
  | { kind: 'windows'; security: WindowsSecurity }
  /** `reason` is fixed text, so a raw load error (which may name EACCES) never reads as a bind failure. */
  | { kind: 'unavailable'; reason: string; detail?: string }

async function readOwnerLookup(): Promise<OwnerLookup> {
  if (process.platform === 'win32') {
    const security = await loadWindowsSecurityAsync()
    if ('error' in security) {
      return {
        kind: 'unavailable',
        reason: 'the Windows security addon did not load',
        detail: security.error
      }
    }
    return security.addon.hasNativeExport('tcpClientOwnerAsync')
      ? { kind: 'windows', security }
      : { kind: 'unavailable', reason: 'the Windows security addon predates the owner lookup' }
  }
  if (process.platform === 'darwin') {
    return (await darwinSocketOwnerHelperAvailable())
      ? { kind: 'darwin' }
      : { kind: 'unavailable', reason: 'the macOS socket owner helper is missing' }
  }
  if (process.platform !== 'linux') {
    return { kind: 'unavailable', reason: `no connection owner lookup on ${process.platform}` }
  }
  const uid = process.getuid?.()
  return uid === undefined
    ? { kind: 'unavailable', reason: 'this process has no user id' }
    : { kind: 'uid', uid }
}

/** Refuses to open a listener whose connections would all be refused for want of an owner lookup. */
export async function assertSocksClientOwnerLookup(listener: string): Promise<void> {
  const lookup = await readOwnerLookup()
  if (lookup.kind !== 'unavailable') {
    return
  }
  if (lookup.detail) {
    console.warn(`[browser-tunnel] ${lookup.reason}: ${lookup.detail}`)
  }
  throw new Error(
    `Can't start the ${listener}: Orca can't confirm which account on this computer opens each connection (${lookup.reason}).`
  )
}

/** Keeps the owner lookup ready while a listener is open (macOS runs a helper); call the result on close. */
export function holdSocksClientOwnerLookup(): () => void {
  return process.platform === 'darwin' ? retainDarwinSocketOwnerHelper() : () => {}
}

/** The client end of the connection must belong to this account: Linux and Windows list every user's
 *  connections with their owner, and macOS looks among this account's own processes. */
export async function verifySocksClientOwner(
  socket: AcceptedSocket,
  readTable: (path: string) => Promise<string> = (path) => readFile(path, 'utf-8'),
  /** Aborts when the connection closes, so a queued macOS lookup is dropped unscanned. */
  closed?: AbortSignal
): Promise<SocksClientOwnerVerdict> {
  const lookup = await readOwnerLookup()
  if (lookup.kind === 'unavailable') {
    const detail = lookup.detail ? `${lookup.reason}: ${lookup.detail}` : lookup.reason
    return { allowed: false, reason: 'lookup-failed', detail }
  }
  const client = toEndpoint(socket.remoteAddress, socket.remotePort)
  const listener = toEndpoint(socket.localAddress, socket.localPort)
  if (!client || !listener) {
    return { allowed: false, reason: 'lookup-failed', detail: 'socket has no address' }
  }
  try {
    if (lookup.kind === 'windows') {
      return await verifyWindowsClientOwner(lookup.security, client, listener)
    }
    if (lookup.kind === 'darwin') {
      // Another account's sockets are unreadable without root, so they read as not ours.
      return (await isOwnDarwinConnection(client, listener, closed))
        ? { allowed: true }
        : { allowed: false, reason: 'lookup-failed', detail: 'no process of this account holds it' }
    }
    // The kernel pages these tables and can skip a row that moved mid-read, so look twice before refusing.
    for (let attempt = 0; attempt < 2; attempt++) {
      // A 4-tuple is unique across both tables; dual-stack clients appear in tcp6 as v4-mapped.
      for (const path of ['/proc/net/tcp', '/proc/net/tcp6']) {
        const uid = findProcNetTcpClientUid(await readTable(path), client, listener)
        if (uid !== null) {
          return uid === lookup.uid
            ? { allowed: true }
            : { allowed: false, reason: 'foreign-owner', owner: `uid ${uid}` }
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

async function verifyWindowsClientOwner(
  security: WindowsSecurity,
  client: Endpoint,
  listener: Endpoint
): Promise<SocksClientOwnerVerdict> {
  const owner = await security.addon.tcpClientOwnerAsync(
    client.host,
    client.port,
    listener.host,
    listener.port
  )
  if (!owner) {
    return { allowed: false, reason: 'lookup-failed', detail: 'client connection not listed' }
  }
  // The browser's own network process may be sandboxed so its token can't be read; it's still ours.
  if ('error' in owner) {
    return isOwnAppProcess(owner.pid)
      ? { allowed: true, unreadableOwnProcess: `pid ${owner.pid}: ${owner.error}` }
      : { allowed: false, reason: 'lookup-failed', detail: owner.error }
  }
  return owner.sid === security.userSid
    ? { allowed: true }
    : { allowed: false, reason: 'foreign-owner', owner: owner.sid }
}

const OWN_APP_PIDS_TTL_MS = 1_000
let ownAppPids: { pids: ReadonlySet<number>; readAt: number } | null = null

/** Brief cache for bursts of connections; a miss re-reads so a just-started child isn't refused. */
function isOwnAppProcess(pid: number): boolean {
  const now = Date.now()
  if (ownAppPids && now - ownAppPids.readAt < OWN_APP_PIDS_TTL_MS && ownAppPids.pids.has(pid)) {
    return true
  }
  ownAppPids = { pids: new Set(app.getAppMetrics().map((metric) => metric.pid)), readAt: now }
  return ownAppPids.pids.has(pid)
}

function toEndpoint(address: string | undefined, port: number | undefined): Endpoint | null {
  if (!address || !port) {
    return null
  }
  // An IPv4 connection may be reported v4-mapped; the owner tables list it as plain IPv4.
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
