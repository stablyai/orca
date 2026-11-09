import { execFile } from 'node:child_process'
import { readdir, readFile, readlink } from 'node:fs/promises'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const TCP_LISTEN = '0A'
// Little-endian hex as /proc/net/tcp{,6} prints them: 127.0.0.0/8, 0.0.0.0, ::1, ::, ::ffff:127.x.
const LOOPBACK_OR_ANY =
  /^(?:[0-9A-F]{6}7F|00000000|0{24}01000000|0{32}|0{16}FFFF0000[0-9A-F]{6}7F|0{16}FFFF000000000000)$/

export type ProcNetListener = { inode: string; uid: number }

/** Listening sockets on `port` reachable from loopback, parsed from /proc/net/tcp or tcp6 text. */
export function parseProcNetListeners(text: string, port: number): ProcNetListener[] {
  const wantedPort = port.toString(16).toUpperCase().padStart(4, '0')
  const listeners: ProcNetListener[] = []
  for (const line of text.split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 10) {
      continue
    }
    const [address, localPort] = (fields[1] ?? '').split(':')
    if (
      fields[3] === TCP_LISTEN &&
      localPort?.toUpperCase() === wantedPort &&
      LOOPBACK_OR_ANY.test((address ?? '').toUpperCase())
    ) {
      listeners.push({ uid: Number(fields[7]), inode: fields[9] ?? '' })
    }
  }
  return listeners
}

async function linuxListenerPids(port: number): Promise<number[]> {
  const uid = process.getuid?.()
  const inodes = new Set<string>()
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    const text = await readFile(table, 'utf8').catch(() => '')
    for (const listener of parseProcNetListeners(text, port)) {
      // Only this host user's own processes; never another account's service.
      if (listener.uid === uid && listener.inode !== '0') {
        inodes.add(`socket:[${listener.inode}]`)
      }
    }
  }
  if (inodes.size === 0) {
    return []
  }
  const pids: number[] = []
  for (const entry of await readdir('/proc').catch(() => [])) {
    if (!/^\d+$/.test(entry)) {
      continue
    }
    const fds = await readdir(`/proc/${entry}/fd`).catch(() => [])
    for (const fd of fds) {
      const target = await readlink(`/proc/${entry}/fd/${fd}`).catch(() => '')
      if (inodes.has(target)) {
        pids.push(Number(entry))
        break
      }
    }
  }
  return pids
}

async function darwinListenerPids(port: number): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync(
      'lsof',
      ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-a', '-u', String(process.getuid?.()), '-Fp'],
      { timeout: 5_000 }
    )
    return stdout
      .split('\n')
      .filter((line) => line.startsWith('p'))
      .map((line) => Number(line.slice(1)))
      .filter(Number.isInteger)
  } catch {
    return []
  }
}

/** Pids of this user's processes, other than orcad itself, listening for loopback on `port`. */
export async function loopbackListenerPids(port: number): Promise<number[]> {
  const pids =
    process.platform === 'linux'
      ? await linuxListenerPids(port)
      : process.platform === 'darwin'
        ? await darwinListenerPids(port)
        : []
  return pids.filter((pid) => pid !== process.pid)
}
