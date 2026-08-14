import type { Dirent } from 'node:fs'
import { open, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import {
  fetchAntigravityQuotaEndpoint,
  getAntigravityCliLogDirectory,
  getAntigravityLanguageServerLogPath,
  parseAntigravityAppConfig,
  parseAntigravityCliServerPorts,
  parseAntigravityLanguageServerPort,
  requestAntigravityLoopbackPage,
  AntigravityLoopbackResponseError,
  type AntigravityLoopbackProtocol
} from './antigravity-loopback-client'

const CLI_LOG_LIMIT = 12
const ENDPOINT_ATTEMPT_LIMIT = 8
const FETCH_TIMEOUT_MS = 6_000
const LOG_TAIL_LIMIT_BYTES = 128 * 1024

type FetchAttempt = {
  discovered: boolean
  answered: boolean
  limits: ProviderRateLimits | null
}

export type AntigravityUsageFetchOptions = {
  signal?: AbortSignal
  homePath?: string
  appDataPath?: string
  platform?: NodeJS.Platform
}

async function readLogTail(filePath: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  const handle = await open(filePath, 'r')
  try {
    const stats = await handle.stat()
    if (!stats.isFile()) {
      throw new Error('Antigravity log target is not a file')
    }
    const byteLength = Math.min(stats.size, LOG_TAIL_LIMIT_BYTES)
    if (byteLength === 0) {
      return ''
    }
    const buffer = Buffer.allocUnsafe(byteLength)
    const { bytesRead } = await handle.read(buffer, 0, byteLength, stats.size - byteLength)
    signal.throwIfAborted()
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}

async function fetchFromCliLogs(homePath: string, signal: AbortSignal): Promise<FetchAttempt> {
  let entries: Dirent[]
  try {
    entries = await readdir(getAntigravityCliLogDirectory(homePath), { withFileTypes: true })
  } catch {
    return { discovered: false, answered: false, limits: null }
  }
  const logDirectory = getAntigravityCliLogDirectory(homePath)
  const logNames = entries
    .filter((entry) => entry.isFile() && /^cli-.*\.log$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => b.localeCompare(a))
    .slice(0, CLI_LOG_LIMIT)
  const attemptedEndpoints = new Set<string>()
  let discovered = false

  for (const logName of logNames) {
    signal.throwIfAborted()
    let log: string
    try {
      log = await readLogTail(join(logDirectory, logName), signal)
    } catch {
      signal.throwIfAborted()
      continue
    }
    const ports = parseAntigravityCliServerPorts(log)
    const endpoints: { protocol: AntigravityLoopbackProtocol; port: number | null }[] = [
      { protocol: 'http:', port: ports.http },
      { protocol: 'https:', port: ports.https }
    ]
    let answered = false
    for (const endpoint of endpoints) {
      if (!endpoint.port) {
        continue
      }
      discovered = true
      const key = `${endpoint.protocol}//127.0.0.1:${endpoint.port}`
      if (attemptedEndpoints.has(key) || attemptedEndpoints.size >= ENDPOINT_ATTEMPT_LIMIT) {
        continue
      }
      attemptedEndpoints.add(key)
      try {
        const limits = await fetchAntigravityQuotaEndpoint(endpoint.protocol, endpoint.port, signal)
        answered = true
        if (limits) {
          return { discovered: true, answered: true, limits }
        }
      } catch (error) {
        answered ||= error instanceof AntigravityLoopbackResponseError
        signal.throwIfAborted()
        // A newer one-shot AGY command can leave a stale log above a live session.
      }
    }
    if (answered) {
      // Why: a responding newest runtime owns the current account even when it
      // is warming up; older runtimes can retain a signed-out account in memory.
      return { discovered: true, answered: true, limits: null }
    }
  }
  return { discovered, answered: false, limits: null }
}

async function fetchFromDesktopApp(
  platform: NodeJS.Platform,
  homePath: string,
  appDataPath: string,
  signal: AbortSignal
): Promise<FetchAttempt> {
  let port: number | null
  try {
    const logPath = getAntigravityLanguageServerLogPath(platform, homePath, appDataPath)
    port = parseAntigravityLanguageServerPort(await readLogTail(logPath, signal))
  } catch {
    signal.throwIfAborted()
    return { discovered: false, answered: false, limits: null }
  }
  if (!port) {
    return { discovered: false, answered: false, limits: null }
  }

  let answered = false
  try {
    const limits = await fetchAntigravityQuotaEndpoint('https:', port, signal)
    answered = true
    if (limits) {
      return { discovered: true, answered: true, limits }
    }
  } catch (error) {
    answered ||= error instanceof AntigravityLoopbackResponseError
    signal.throwIfAborted()
  }

  try {
    const html = await requestAntigravityLoopbackPage('https:', port, '/', signal)
    answered = true
    const config = parseAntigravityAppConfig(html)
    const limits = config
      ? await fetchAntigravityQuotaEndpoint('https:', port, signal, config.csrfToken)
      : null
    return { discovered: true, answered: true, limits }
  } catch (error) {
    answered ||= error instanceof AntigravityLoopbackResponseError
    signal.throwIfAborted()
    return { discovered: true, answered, limits: null }
  }
}

function emptyResult(
  status: 'error' | 'unavailable',
  error: string,
  failureKind: 'usage-unavailable' | 'cli-unavailable'
): ProviderRateLimits {
  return {
    provider: 'antigravity',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error,
    status,
    usageMetadata: {
      source: 'live-session',
      attemptedSources: ['live-session'],
      failureKind,
      credentialSource: 'agy-local-service',
      authProvenance: 'antigravity'
    }
  }
}

/** Reads Antigravity quotas from the newest responsive host-local runtime. */
export async function fetchAntigravityRateLimits(
  options: AntigravityUsageFetchOptions = {}
): Promise<ProviderRateLimits> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  const onAbort = (): void => controller.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', onAbort, { once: true })
  if (options.signal?.aborted) {
    onAbort()
  }

  try {
    controller.signal.throwIfAborted()
    const homePath = options.homePath ?? homedir()
    const cliAttempt = await fetchFromCliLogs(homePath, controller.signal)
    if (cliAttempt.limits) {
      return cliAttempt.limits
    }
    if (cliAttempt.answered) {
      return emptyResult(
        'error',
        'Antigravity model quota summary is unavailable',
        'usage-unavailable'
      )
    }
    const appDataPath = options.appDataPath ?? app.getPath('appData')
    const desktopAttempt = await fetchFromDesktopApp(
      options.platform ?? process.platform,
      homePath,
      appDataPath,
      controller.signal
    )
    if (desktopAttempt.limits) {
      return desktopAttempt.limits
    }
    controller.signal.throwIfAborted()
    return cliAttempt.discovered || desktopAttempt.discovered
      ? emptyResult('error', 'Antigravity model quota summary is unavailable', 'usage-unavailable')
      : emptyResult(
          'unavailable',
          'Antigravity local usage service is not running',
          'cli-unavailable'
        )
  } catch (error) {
    if (options.signal?.aborted) {
      throw error
    }
    return emptyResult(
      'error',
      error instanceof Error ? error.message : 'Unknown Antigravity usage error',
      'usage-unavailable'
    )
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', onAbort)
  }
}
