import { open, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

/**
 * Every `agy` run records its own pid and both loopback ports in the first lines of a
 * timestamped CLI log, so quota discovery needs neither `lsof`/`ps` nor a process table.
 */
export type AntigravityLanguageServerEndpoint = {
  pid: number
  /** Plaintext loopback port. Preferred, because it needs no self-signed TLS exception. */
  httpPort: number | null
  /** TLS loopback port, presented with a self-signed certificate. */
  httpsPort: number | null
}

export const ANTIGRAVITY_CLI_LOG_DIR = path.join(homedir(), '.gemini', 'antigravity-cli', 'log')

// The pid/port lines are emitted before anything else, so a small head read always covers them.
const LOG_HEAD_BYTES = 8192
// A signed-out or crashed run leaves its log behind; cap how far back a stale tail is scanned.
const MAX_LOG_CANDIDATES = 12

/** Parses `agy`'s startup banner. Both port lines are optional — older builds logged only one. */
export function parseAntigravityLanguageServerLog(
  logHead: string
): AntigravityLanguageServerEndpoint | null {
  const pid = Number(/Starting language server process with pid (\d+)/.exec(logHead)?.[1])
  if (!Number.isInteger(pid) || pid <= 0) {
    return null
  }
  let httpPort: number | null = null
  let httpsPort: number | null = null
  // Why: the HTTPS line reads "... for HTTPS (gRPC)", so match the scheme as a whole token.
  const portPattern = /listening on random port at (\d+) for (HTTPS|HTTP)\b/g
  for (const match of logHead.matchAll(portPattern)) {
    const port = Number(match[1])
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      continue
    }
    if (match[2] === 'HTTP') {
      httpPort ??= port
    } else {
      httpsPort ??= port
    }
  }
  if (httpPort === null && httpsPort === null) {
    return null
  }
  return { pid, httpPort, httpsPort }
}

export type AntigravityLogSource = {
  listLogFileNames: () => Promise<string[]>
  readLogHead: (fileName: string) => Promise<string | null>
  isProcessAlive: (pid: number) => boolean
}

async function readHead(filePath: string): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(filePath, 'r')
    const buffer = Buffer.alloc(LOG_HEAD_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, LOG_HEAD_BYTES, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => {})
  }
}

export function createAntigravityLogSource(logDir = ANTIGRAVITY_CLI_LOG_DIR): AntigravityLogSource {
  return {
    listLogFileNames: async () => {
      try {
        return await readdir(logDir)
      } catch {
        return []
      }
    },
    readLogHead: (fileName) => readHead(path.join(logDir, fileName)),
    isProcessAlive: (pid) => {
      try {
        process.kill(pid, 0)
        return true
      } catch (err) {
        // EPERM means the pid exists but is owned by another user, which still counts as alive.
        return (err as NodeJS.ErrnoException | null)?.code === 'EPERM'
      }
    }
  }
}

/**
 * Live `agy` language servers, newest run first.
 *
 * Why newest-first: a long-lived `agy` keeps the account it started with in memory across a
 * sign-out, so an older process happily answers with a stale account's quota (#9122). Log file
 * names are `cli-YYYYMMDD_HHMMSS.log`, which sorts chronologically as plain text.
 */
export async function discoverAntigravityLanguageServers(
  source: AntigravityLogSource
): Promise<AntigravityLanguageServerEndpoint[]> {
  const fileNames = (await source.listLogFileNames())
    .filter((name) => name.startsWith('cli-') && name.endsWith('.log'))
    .sort()
    .toReversed()
    .slice(0, MAX_LOG_CANDIDATES)

  const endpoints: AntigravityLanguageServerEndpoint[] = []
  const seenPids = new Set<number>()
  for (const fileName of fileNames) {
    const head = await source.readLogHead(fileName)
    const endpoint = head ? parseAntigravityLanguageServerLog(head) : null
    if (!endpoint || seenPids.has(endpoint.pid) || !source.isProcessAlive(endpoint.pid)) {
      continue
    }
    seenPids.add(endpoint.pid)
    endpoints.push(endpoint)
  }
  return endpoints
}
