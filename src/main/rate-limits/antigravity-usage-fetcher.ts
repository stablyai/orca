import { open, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { net } from 'electron'
import { runProcess } from '../../shared/child-process/run-process'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import {
  deduplicateAgyQuotaEndpoints,
  inspectAgyProcessCommands,
  type AgyQuotaEndpoint
} from './antigravity-endpoint-selection'
import { parseAgyQuotaSummary, type AgyQuotaWindows } from './antigravity-quota-parser'

export { parseAgyQuotaSummary } from './antigravity-quota-parser'

const COMMAND_TIMEOUT_MS = 4_000
const FETCH_TIMEOUT_MS = 5_000
const LOG_PREFIX_BYTES = 16 * 1024
const SUMMARY_PATH = '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary'
const AGY_LOG_DIR = path.join(homedir(), '.gemini', 'antigravity-cli', 'log')

type LsofListener = {
  pid: number
  processName: string
  port: number
}

function result(
  status: ProviderRateLimits['status'],
  error: string | null,
  windows?: AgyQuotaWindows
): ProviderRateLimits {
  return {
    provider: 'antigravity',
    session: windows?.session ?? null,
    weekly: windows?.weekly ?? null,
    ...(windows ? { buckets: windows.buckets } : {}),
    updatedAt: Date.now(),
    error,
    status,
    usageMetadata: {
      source: 'live-session',
      credentialSource: 'agy-local-service',
      authProvenance: 'antigravity',
      ...(status === 'unavailable' ? { failureKind: 'cli-unavailable' as const } : {})
    }
  }
}

async function runCommand(command: string, args: string[]): Promise<string> {
  const commandResult = await runProcess({
    program: command,
    args,
    timeoutMs: COMMAND_TIMEOUT_MS,
    maxOutputBytes: 2 * 1024 * 1024
  })
  if (commandResult.code !== 0) {
    throw new Error(commandResult.stderr || `${command} exited without success`)
  }
  return commandResult.stdout
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (
      error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EPERM'
    )
  }
}

async function readFilePrefix(filePath: string): Promise<string> {
  const handle = await open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(LOG_PREFIX_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}

export function parseAgyLogEndpoint(log: string): AgyQuotaEndpoint | null {
  const pid = Number.parseInt(
    log.match(/Starting language server process with pid\s+(\d+)/)?.[1] ?? '',
    10
  )
  const port = Number.parseInt(
    log.match(/Language server listening on (?:random|fixed) port at\s+(\d+)\s+for HTTP\b/)?.[1] ??
      '',
    10
  )
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(port) || port < 1 || port > 65_535) {
    return null
  }
  return { pid, port, csrfToken: null }
}

export function parseLsofListeners(output: string): LsofListener[] {
  const listeners: LsofListener[] = []
  let pid: number | null = null
  let processName = ''
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) {
      pid = Number.parseInt(line.slice(1), 10)
      processName = ''
      continue
    }
    if (line.startsWith('c')) {
      processName = line.slice(1)
      continue
    }
    if (!line.startsWith('n') || !pid || !processName) {
      continue
    }
    const port = Number.parseInt(line.match(/:(\d+)(?:\s+\(LISTEN\))?$/)?.[1] ?? '', 10)
    if (Number.isInteger(port) && port > 0 && port <= 65_535) {
      listeners.push({ pid, processName, port })
    }
  }
  return listeners
}

export function parseCsrfToken(commandLine: string): string | null {
  return commandLine.match(/(?:^|\s)--csrf_token(?:=|\s+)([^\s]+)/)?.[1] ?? null
}

export async function collectLiveAgyLogEndpoints(
  names: string[],
  readLog: (name: string) => Promise<string>,
  processAlive: (pid: number) => boolean = isProcessAlive
): Promise<AgyQuotaEndpoint[]> {
  const endpoints: AgyQuotaEndpoint[] = []
  for (const name of names) {
    try {
      const endpoint = parseAgyLogEndpoint(await readLog(name))
      if (endpoint && processAlive(endpoint.pid)) {
        endpoints.push(endpoint)
      }
    } catch {
      continue
    }
  }
  return endpoints
}

async function discoverLogEndpoints(): Promise<AgyQuotaEndpoint[]> {
  try {
    const names = (await readdir(AGY_LOG_DIR))
      .filter((name) => /^cli-\d{8}_\d{6}\.log$/.test(name))
      .sort()
      .toReversed()
      .slice(0, 8)
    return collectLiveAgyLogEndpoints(names, (name) => readFilePrefix(path.join(AGY_LOG_DIR, name)))
  } catch {
    return []
  }
}

async function discoverLsofEndpoints(): Promise<AgyQuotaEndpoint[]> {
  if (process.platform === 'win32') {
    return []
  }
  try {
    const listeners = parseLsofListeners(
      await runCommand('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcn'])
    ).filter(({ processName }) => /^(agy|language_?(?:server)?)$/i.test(processName))
    const commandLines = await inspectAgyProcessCommands(
      new Set(listeners.map((listener) => listener.pid)),
      (pid) => runCommand('ps', ['-p', String(pid), '-o', 'command='])
    )
    return listeners.flatMap<AgyQuotaEndpoint>(({ pid, processName, port }) => {
      const commandLine = commandLines.get(pid) ?? ''
      if (/^agy$/i.test(processName)) {
        return [{ pid, port, csrfToken: null }]
      }
      if (
        !commandLine.includes('language_server') ||
        !commandLine.toLowerCase().includes('antigravity')
      ) {
        return []
      }
      const csrfToken = parseCsrfToken(commandLine)
      return csrfToken ? [{ pid, port, csrfToken }] : []
    })
  } catch {
    return []
  }
}

export async function discoverAgyQuotaEndpoints(): Promise<AgyQuotaEndpoint[]> {
  const endpoints = [...(await discoverLogEndpoints()), ...(await discoverLsofEndpoints())]
  return deduplicateAgyQuotaEndpoints(endpoints)
}

async function fetchSummary(endpoint: AgyQuotaEndpoint): Promise<unknown> {
  const response = await net.fetch(`http://127.0.0.1:${endpoint.port}${SUMMARY_PATH}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(endpoint.csrfToken ? { 'x-codeium-csrf-token': endpoint.csrfToken } : {})
    },
    body: '{}',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  })
  return response.ok ? await response.json() : null
}

export async function fetchAntigravityRateLimits(
  discoverEndpoints: () => Promise<AgyQuotaEndpoint[]> = discoverAgyQuotaEndpoints
): Promise<ProviderRateLimits> {
  try {
    const endpoints = await discoverEndpoints()
    if (endpoints.length === 0) {
      return result('unavailable', 'Agy local usage service is not running')
    }
    for (const endpoint of endpoints) {
      try {
        const windows = parseAgyQuotaSummary(await fetchSummary(endpoint))
        if (windows) {
          return result('ok', null, windows)
        }
      } catch {
        // Agy exposes adjacent HTTPS and HTTP listeners; only the HTTP endpoint answers here.
      }
    }
    return result('error', 'Agy model quota summary is unavailable')
  } catch (error) {
    return result('error', error instanceof Error ? error.message : 'Unknown Agy usage error')
  }
}
