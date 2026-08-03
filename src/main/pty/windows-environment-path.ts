import { execFile, execFileSync } from 'node:child_process'
import {
  expandWindowsEnvironmentVariables,
  expandWindowsPathEnvironmentVariables
} from '../../shared/windows-environment-expansion'
import { getRegExePath } from '../win32-utils'

type ExecFile = typeof execFile
type ExecFileSync = typeof execFileSync

type ReadWindowsPathOptions = {
  execFile?: ExecFile
  execFileSync?: ExecFileSync
  env?: NodeJS.ProcessEnv
  forceRefresh?: boolean
  platform?: NodeJS.Platform
}

type RegistryPathRead = {
  failed: boolean
  segments: string[]
}

const WINDOWS_PATH_REGISTRY_KEYS = [
  ['HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', 'Path'],
  ['HKCU\\Environment', 'Path']
] as const

const PERSISTED_WINDOWS_PATH_CACHE_TTL_MS = 30_000
const PERSISTED_WINDOWS_PATH_QUERY_TIMEOUT_MS = 5_000

let persistedWindowsPathCache:
  | {
      readAt: number
      segments: string[]
    }
  | undefined
let pendingPersistedWindowsPathRefresh: Promise<string[]> | undefined

function parseRegistryPathValue(output: string, valueName: string): string | null {
  const valuePattern = new RegExp(`^\\s*${valueName}\\s+REG_\\w+\\s+(.*)$`, 'i')
  for (const line of output.split(/\r?\n/)) {
    const match = valuePattern.exec(line)
    if (match) {
      return match[1]?.trim() ?? ''
    }
  }
  return null
}

function getPathDelimiter(platform: NodeJS.Platform): string {
  return platform === 'win32' ? ';' : ':'
}

function splitPathSegments(pathValue: string, pathDelimiter: string): string[] {
  return pathValue
    .split(pathDelimiter)
    .map((segment) => segment.trim())
    .filter(Boolean)
}

function registryOutputSegments(
  output: string,
  valueName: string,
  env: NodeJS.ProcessEnv,
  pathDelimiter: string
): string[] {
  const value = parseRegistryPathValue(output, valueName)
  return value
    ? splitPathSegments(expandWindowsEnvironmentVariables(value, env), pathDelimiter)
    : []
}

function keepLastGoodSegments(segments: string[], failedReads: number): string[] {
  if (failedReads === WINDOWS_PATH_REGISTRY_KEYS.length && persistedWindowsPathCache) {
    return [...persistedWindowsPathCache.segments]
  }
  return segments
}

function cachePersistedWindowsPathSegments(segments: string[], failedReads: number): string[] {
  // Why: timeouts or policy blocks must not replace a usable cache, while successful empty
  // registry values still need to remove stale entries.
  const kept = keepLastGoodSegments(segments, failedReads)
  persistedWindowsPathCache = { readAt: Date.now(), segments: [...kept] }
  return [...kept]
}

function readRegistryPathAsync(
  run: ExecFile,
  executable: string,
  registryValue: readonly [key: string, valueName: string],
  env: NodeJS.ProcessEnv,
  pathDelimiter: string
): Promise<RegistryPathRead> {
  const [key, valueName] = registryValue
  return new Promise((resolve) => {
    run(
      executable,
      ['query', key, '/v', valueName],
      { encoding: 'utf8', timeout: PERSISTED_WINDOWS_PATH_QUERY_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => {
        if (error) {
          resolve({ failed: true, segments: [] })
          return
        }
        resolve({
          failed: false,
          segments: registryOutputSegments(String(stdout), valueName, env, pathDelimiter)
        })
      }
    )
  })
}

export function readPersistedWindowsPathSegments(options: ReadWindowsPathOptions = {}): string[] {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') {
    return []
  }

  const useProductionCache =
    options.execFile === undefined &&
    options.execFileSync === undefined &&
    options.env === undefined &&
    options.platform === undefined
  const now = Date.now()
  if (
    !options.forceRefresh &&
    useProductionCache &&
    persistedWindowsPathCache &&
    now - persistedWindowsPathCache.readAt < PERSISTED_WINDOWS_PATH_CACHE_TTL_MS
  ) {
    return [...persistedWindowsPathCache.segments]
  }

  if (
    !options.forceRefresh &&
    useProductionCache &&
    pendingPersistedWindowsPathRefresh &&
    persistedWindowsPathCache
  ) {
    // Why: synchronous PTY construction cannot await the active refresh; its stale cache is
    // safer than duplicating the registry read on Electron's main thread.
    return [...persistedWindowsPathCache.segments]
  }

  const run = options.execFileSync ?? execFileSync
  const env = options.env ?? process.env
  const pathDelimiter = getPathDelimiter(platform)
  const segments: string[] = []
  let failedReads = 0

  for (const [key, valueName] of WINDOWS_PATH_REGISTRY_KEYS) {
    try {
      const output = run(getRegExePath(env), ['query', key, '/v', valueName], {
        encoding: 'utf8',
        timeout: PERSISTED_WINDOWS_PATH_QUERY_TIMEOUT_MS,
        windowsHide: true
      })
      segments.push(...registryOutputSegments(output, valueName, env, pathDelimiter))
    } catch {
      // Registry access can fail in stripped test containers or remote-like
      // Windows contexts. Existing PATH remains the fallback in those cases.
      failedReads += 1
    }
  }

  if (!useProductionCache) {
    return segments
  }

  // Why: local PTY spawn is a hot path on Windows, and each uncached read
  // runs two synchronous `reg.exe query` subprocesses. A short TTL keeps
  // terminal bursts cheap while still picking up newly installed CLIs soon.
  return cachePersistedWindowsPathSegments(segments, failedReads)
}

export async function readPersistedWindowsPathSegmentsAsync(
  options: ReadWindowsPathOptions = {}
): Promise<string[]> {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') {
    return []
  }

  const useProductionCache =
    options.execFile === undefined &&
    options.execFileSync === undefined &&
    options.env === undefined &&
    options.platform === undefined
  const now = Date.now()
  if (
    !options.forceRefresh &&
    useProductionCache &&
    persistedWindowsPathCache &&
    now - persistedWindowsPathCache.readAt < PERSISTED_WINDOWS_PATH_CACHE_TTL_MS
  ) {
    return [...persistedWindowsPathCache.segments]
  }
  if (useProductionCache && pendingPersistedWindowsPathRefresh) {
    return [...(await pendingPersistedWindowsPathRefresh)]
  }

  const run = options.execFile ?? execFile
  const env = options.env ?? process.env
  const pathDelimiter = getPathDelimiter(platform)
  const executable = getRegExePath(env)
  const refresh = Promise.all(
    WINDOWS_PATH_REGISTRY_KEYS.map((registryValue) =>
      readRegistryPathAsync(run, executable, registryValue, env, pathDelimiter)
    )
  ).then((reads) => {
    const segments = reads.flatMap((read) => read.segments)
    if (!useProductionCache) {
      return segments
    }
    return cachePersistedWindowsPathSegments(segments, reads.filter((read) => read.failed).length)
  })

  if (!useProductionCache) {
    return refresh
  }
  pendingPersistedWindowsPathRefresh = refresh
  try {
    return [...(await refresh)]
  } finally {
    if (pendingPersistedWindowsPathRefresh === refresh) {
      pendingPersistedWindowsPathRefresh = undefined
    }
  }
}

export function __resetPersistedWindowsPathCacheForTests(): void {
  persistedWindowsPathCache = undefined
  pendingPersistedWindowsPathRefresh = undefined
}

function mergeWindowsPathSegments(
  env: NodeJS.ProcessEnv,
  persistedSegments: string[],
  platform: NodeJS.Platform,
  sourceEnv: NodeJS.ProcessEnv
): void {
  expandWindowsPathEnvironmentVariables(env, platform)
  const pathKey = env.Path !== undefined ? 'Path' : env.PATH !== undefined ? 'PATH' : 'Path'
  const pathDelimiter = getPathDelimiter(platform)
  const currentPath = env[pathKey] ?? sourceEnv.PATH ?? sourceEnv.Path ?? ''
  const currentSegments = splitPathSegments(currentPath, pathDelimiter)
  const existing = new Set(currentSegments.map((segment) => segment.toLowerCase()))
  const missing = persistedSegments.filter((segment) => {
    const normalized = segment.toLowerCase()
    if (existing.has(normalized)) {
      return false
    }
    existing.add(normalized)
    return true
  })

  if (missing.length > 0) {
    env[pathKey] = [...currentSegments, ...missing].join(pathDelimiter)
  }
}

export function mergePersistedWindowsPath(
  env: NodeJS.ProcessEnv,
  options: ReadWindowsPathOptions = {}
): void {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') {
    return
  }

  const sourceEnv = options.env ?? process.env
  // Why: Windows broadcasts PATH changes to future processes, but a running
  // Electron app keeps its old environment. Append the persisted additions so
  // newly installed CLIs resolve without unexpectedly reordering existing PATH.
  mergeWindowsPathSegments(env, readPersistedWindowsPathSegments(options), platform, sourceEnv)
}

export async function mergePersistedWindowsPathAsync(
  env: NodeJS.ProcessEnv,
  options: ReadWindowsPathOptions = {}
): Promise<void> {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') {
    return
  }
  const sourceEnv = options.env ?? process.env
  const persistedSegments = await readPersistedWindowsPathSegmentsAsync(options)
  mergeWindowsPathSegments(env, persistedSegments, platform, sourceEnv)
}
