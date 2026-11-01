import { readFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import { codexDaemonSocketPath } from './codex-daemon-socket-path-guard'
import { readWindowsProcessCreationTime } from '../windows/windows-process-table'

/** `absent` only on proof; anything the probe cannot settle is `unknown`. */
export type CodexSharedServerState = 'live' | 'absent' | 'unknown'

const CONNECT_TIMEOUT_MS = 1_000
// Codex's FILETIME epoch (1601) sits this far before the Unix epoch.
const FILETIME_UNIX_EPOCH_OFFSET_MS = 11_644_473_600_000n

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
}

// A crashed server can leave its socket file behind.
function probeSocket(socketPath: string): Promise<CodexSharedServerState> {
  return new Promise((resolve) => {
    const socket = createConnection({ path: socketPath })
    const settle = (state: CodexSharedServerState): void => {
      socket.destroy()
      resolve(state)
    }
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => settle('unknown'))
    socket.once('connect', () => settle('live'))
    socket.once('error', (error) => {
      const code = errorCode(error)
      settle(code === 'ECONNREFUSED' || code === 'ENOENT' ? 'absent' : 'unknown')
    })
  })
}

async function probeWindowsRecord(path: string): Promise<CodexSharedServerState> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? 'absent' : 'unknown'
  }
  let record: unknown
  try {
    record = JSON.parse(text)
  } catch {
    return 'unknown'
  }
  if (
    typeof record !== 'object' ||
    record === null ||
    !('pid' in record) ||
    typeof record.pid !== 'number' ||
    !Number.isSafeInteger(record.pid) ||
    record.pid <= 0
  ) {
    return 'unknown'
  }
  try {
    process.kill(record.pid, 0)
  } catch (error) {
    // Only ESRCH proves absence; EPERM still permits a live process.
    return errorCode(error) === 'ESRCH' ? 'absent' : 'unknown'
  }
  const createdAtMs = readWindowsProcessCreationTime(record.pid)
  if (
    createdAtMs === null ||
    !('processStartTime' in record) ||
    typeof record.processStartTime !== 'string' ||
    !/^\d+$/.test(record.processStartTime)
  ) {
    return 'unknown'
  }
  const startedAtMs = Number(
    BigInt(record.processStartTime) / 10_000n - FILETIME_UNIX_EPOCH_OFFSET_MS
  )
  // A different creation time means the server PID was reused.
  return Math.abs(createdAtMs - startedAtMs) < 1_000 ? 'live' : 'absent'
}

// Windows libuv cannot open Codex's AF_UNIX socket; verify PID creation times instead.
async function probeWindowsRecords(codexHome: string): Promise<CodexSharedServerState> {
  const states = await Promise.all(
    ['daemon.pid', 'app-server.pid'].map((name) =>
      probeWindowsRecord(join(codexHome, 'app-server-daemon', name))
    )
  )
  return states.includes('live') ? 'live' : states.includes('unknown') ? 'unknown' : 'absent'
}

export function probeCodexSharedServer(codexHome: string): Promise<CodexSharedServerState> {
  return process.platform === 'win32'
    ? probeWindowsRecords(codexHome)
    : probeSocket(codexDaemonSocketPath(codexHome))
}
