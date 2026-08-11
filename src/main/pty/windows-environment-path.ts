import type { execFile, execFileSync } from 'node:child_process'
import { expandWindowsEnvironmentVariables } from '../../shared/windows-environment-expansion'
import { getRegExePath } from '../win32-utils'
import { mergeWindowsPathSegments } from './windows-path-segment-merge'
import { readWindowsPathRegistry } from './windows-path-registry-reader'

export { resolvePathEnvKey } from './windows-path-segment-merge'

type ExecFile = typeof execFile
type ExecFileSync = typeof execFileSync

type ReadWindowsPathOptions = {
  execFile?: ExecFile
  execFileSync?: ExecFileSync
  env?: NodeJS.ProcessEnv
  forceRefresh?: boolean
  platform?: NodeJS.Platform
}

type RegistryPathRead = { failed: boolean; segments: string[] }

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
let persistedWindowsPathCacheGeneration = 0

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

function readNativeRegistryPaths(
  env: NodeJS.ProcessEnv,
  pathDelimiter: string
): RegistryPathRead[] {
  return readWindowsPathRegistry().map((read) => ({
    failed: read.failed,
    segments:
      read.value === null
        ? []
        : splitPathSegments(expandWindowsEnvironmentVariables(read.value, env), pathDelimiter)
  }))
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

  const env = options.env ?? process.env
  const pathDelimiter = getPathDelimiter(platform)
  const reads = options.execFileSync
    ? WINDOWS_PATH_REGISTRY_KEYS.map(([key, valueName]) => {
        try {
          const output = options.execFileSync!(
            getRegExePath(env),
            ['query', key, '/v', valueName],
            {
              encoding: 'utf8',
              timeout: PERSISTED_WINDOWS_PATH_QUERY_TIMEOUT_MS,
              windowsHide: true
            }
          )
          return {
            failed: false,
            segments: registryOutputSegments(output, valueName, env, pathDelimiter)
          }
        } catch {
          return { failed: true, segments: [] }
        }
      })
    : readNativeRegistryPaths(env, pathDelimiter)
  const segments = reads.flatMap((read) => read.segments)
  const failedReads = reads.filter((read) => read.failed).length

  if (!useProductionCache) {
    return segments
  }

  // Why: local PTY spawn is a hot path on Windows, and each uncached refresh performs two
  // synchronous native registry reads. A short TTL keeps terminal bursts cheap while still
  // picking up newly installed CLIs soon.
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

  const env = options.env ?? process.env
  const pathDelimiter = getPathDelimiter(platform)
  const cacheGeneration = persistedWindowsPathCacheGeneration
  const refresh = (
    options.execFile
      ? Promise.all(
          WINDOWS_PATH_REGISTRY_KEYS.map((registryValue) =>
            readRegistryPathAsync(
              options.execFile!,
              getRegExePath(env),
              registryValue,
              env,
              pathDelimiter
            )
          )
        )
      : Promise.resolve(readNativeRegistryPaths(env, pathDelimiter))
  ).then((reads) => {
    const segments = reads.flatMap((read) => read.segments)
    if (!useProductionCache) {
      return segments
    }
    if (cacheGeneration !== persistedWindowsPathCacheGeneration) {
      // Why: callers must not merge or inspect a snapshot invalidated while its queries ran.
      return readPersistedWindowsPathSegmentsAsync()
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
  invalidatePersistedWindowsPathCache()
}

export function invalidatePersistedWindowsPathCache(): void {
  persistedWindowsPathCacheGeneration += 1
  persistedWindowsPathCache = undefined
  pendingPersistedWindowsPathRefresh = undefined
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
  // Why: append-only merging lets stale entries shadow newly installed executables.
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
