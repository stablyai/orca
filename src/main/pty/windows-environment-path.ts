import type { execFile, execFileSync } from 'node:child_process'
import { expandWindowsEnvironmentVariables } from '../../shared/windows-environment-expansion'
import { getRegExePath } from '../win32-utils'
import { runProcess } from '@orca/process-host'
import { mergeWindowsPathSegments } from './windows-path-segment-merge'
import {
  WindowsPathRegistryFallback,
  type RegistryPathRead
} from './windows-path-registry-fallback'
import { readWindowsPathRegistry } from './windows-path-registry-reader'

export { resolvePathEnvKey } from './windows-path-segment-merge'

type ExecFile = typeof execFile
type ExecFileSync = typeof execFileSync

type ReadWindowsPathOptions = {
  execFile?: ExecFile
  execFileSync?: ExecFileSync
  env?: NodeJS.ProcessEnv
  forceRefresh?: boolean
  /** Joins a read in progress only if it started at or after this time; else starts one. */
  startedAfter?: number
  platform?: NodeJS.Platform
}

const WINDOWS_PATH_REGISTRY_KEYS = [
  ['HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', 'Path'],
  ['HKCU\\Environment', 'Path']
] as const

const PERSISTED_WINDOWS_PATH_CACHE_TTL_MS = 30_000
const PERSISTED_WINDOWS_PATH_QUERY_TIMEOUT_MS = 5_000
const windowsPathRegistryFallback = new WindowsPathRegistryFallback(
  WINDOWS_PATH_REGISTRY_KEYS.length
)

let persistedWindowsPathCache:
  | {
      readAt: number
      segments: string[]
    }
  | undefined
let pendingPersistedWindowsPathRefresh: Promise<string[]> | undefined
let pendingPersistedWindowsPathRefreshStartedAt = 0
let persistedWindowsPathCacheGeneration = 0
let persistedWindowsPathReadSequence = 0
let persistedWindowsPathCommittedSequence = 0

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

const FAILED_REGISTRY_READS: RegistryPathRead[] = WINDOWS_PATH_REGISTRY_KEYS.map(() => ({
  failed: true,
  segments: []
}))

/** Null when the native addon cannot load. */
function readNativeRegistryPaths(
  env: NodeJS.ProcessEnv,
  pathDelimiter: string
): RegistryPathRead[] | null {
  const reads = readWindowsPathRegistry()
  if (reads === null) {
    return null
  }
  return reads.map((read) => ({
    failed: read.failed,
    segments:
      read.value === null
        ? []
        : splitPathSegments(expandWindowsEnvironmentVariables(read.value, env), pathDelimiter)
  }))
}

function cachePersistedWindowsPathReads(reads: RegistryPathRead[], readSequence: number): string[] {
  if (readSequence < persistedWindowsPathCommittedSequence) {
    // An older async read must not overwrite a newer synchronous refresh.
    return persistedWindowsPathCache ? [...persistedWindowsPathCache.segments] : []
  }
  persistedWindowsPathCommittedSequence = readSequence
  const segments = windowsPathRegistryFallback.commitReads(reads)
  if (!segments) {
    // Cache unresolved hives too, preserving ordering without repeated spawn-path reads.
    persistedWindowsPathCache = { readAt: Date.now(), segments: [] }
    return []
  }
  persistedWindowsPathCache = { readAt: Date.now(), segments: [...segments] }
  return [...segments]
}

/** Stdout of `reg query`, or null when the query failed. */
type RegQuery = (executable: string, args: string[]) => Promise<string | null>

function execFileRegQuery(run: ExecFile): RegQuery {
  return (executable, args) =>
    new Promise((resolve) => {
      run(
        executable,
        args,
        { encoding: 'utf8', timeout: PERSISTED_WINDOWS_PATH_QUERY_TIMEOUT_MS, windowsHide: true },
        (error, stdout) => resolve(error ? null : String(stdout))
      )
    })
}

async function runProcessRegQuery(executable: string, args: string[]): Promise<string | null> {
  try {
    const result = await runProcess({
      program: executable,
      args,
      timeoutMs: PERSISTED_WINDOWS_PATH_QUERY_TIMEOUT_MS
    })
    return result.code === 0 && !result.timedOut ? result.stdout : null
  } catch {
    return null
  }
}

function readRegExePathsAsync(
  query: RegQuery,
  env: NodeJS.ProcessEnv,
  pathDelimiter: string
): Promise<RegistryPathRead[]> {
  return Promise.all(
    WINDOWS_PATH_REGISTRY_KEYS.map(async ([key, valueName]) => {
      // Missing /v Path fails reg.exe; querying the key treats an absent value as empty like native reads.
      const stdout = await query(getRegExePath(env), ['query', key])
      return stdout === null
        ? { failed: true, segments: [] }
        : {
            failed: false,
            segments: registryOutputSegments(stdout, valueName, env, pathDelimiter)
          }
    })
  )
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

  if (!options.forceRefresh && useProductionCache && pendingPersistedWindowsPathRefresh) {
    // Synchronous PTY construction uses stale cache instead of blocking main on a duplicate registry read.
    return persistedWindowsPathCache ? [...persistedWindowsPathCache.segments] : []
  }

  const env = options.env ?? process.env
  const pathDelimiter = getPathDelimiter(platform)
  const readSequence = useProductionCache ? ++persistedWindowsPathReadSequence : 0
  const reads = options.execFileSync
    ? WINDOWS_PATH_REGISTRY_KEYS.map(([key, valueName]) => {
        try {
          const output = options.execFileSync!(getRegExePath(env), ['query', key], {
            encoding: 'utf8',
            timeout: PERSISTED_WINDOWS_PATH_QUERY_TIMEOUT_MS,
            windowsHide: true
          })
          return {
            failed: false,
            segments: registryOutputSegments(output, valueName, env, pathDelimiter)
          }
        } catch {
          return { failed: true, segments: [] }
        }
      })
    : // Never fork synchronous reg.exe on the PTY hot path; async refresh fills the cache.
      (readNativeRegistryPaths(env, pathDelimiter) ?? FAILED_REGISTRY_READS)
  const segments = reads.flatMap((read) => read.segments)
  if (!useProductionCache) {
    return segments
  }

  // Short TTL shares native registry reads across terminal bursts while picking up new CLIs.
  return cachePersistedWindowsPathReads(reads, readSequence)
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
  if (
    useProductionCache &&
    pendingPersistedWindowsPathRefresh &&
    pendingPersistedWindowsPathRefreshStartedAt >= (options.startedAfter ?? -Infinity)
  ) {
    return [...(await pendingPersistedWindowsPathRefresh)]
  }

  const env = options.env ?? process.env
  const pathDelimiter = getPathDelimiter(platform)
  const cacheGeneration = persistedWindowsPathCacheGeneration
  const readSequence = useProductionCache ? ++persistedWindowsPathReadSequence : 0
  const refresh = (
    options.execFile
      ? readRegExePathsAsync(execFileRegQuery(options.execFile), env, pathDelimiter)
      : // Server slots lack the native addon and need the reg.exe fallback.
        Promise.resolve(
          readNativeRegistryPaths(env, pathDelimiter) ??
            readRegExePathsAsync(runProcessRegQuery, env, pathDelimiter)
        )
  ).then((reads) => {
    const segments = reads.flatMap((read) => read.segments)
    if (!useProductionCache) {
      return segments
    }
    if (cacheGeneration !== persistedWindowsPathCacheGeneration) {
      // Retry snapshots invalidated while registry queries were running.
      return readPersistedWindowsPathSegmentsAsync()
    }
    return cachePersistedWindowsPathReads(reads, readSequence)
  })

  if (!useProductionCache) {
    return refresh
  }
  pendingPersistedWindowsPathRefresh = refresh
  pendingPersistedWindowsPathRefreshStartedAt = now
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
  windowsPathRegistryFallback.reset()
  persistedWindowsPathReadSequence = 0
  persistedWindowsPathCommittedSequence = 0
}

export function invalidatePersistedWindowsPathCache(): void {
  persistedWindowsPathCacheGeneration += 1
  persistedWindowsPathCache = undefined
  pendingPersistedWindowsPathRefresh = undefined
}

/** The last committed registry PATH; reading it never starts or waits for a refresh. */
export function cachedPersistedWindowsPathSegments(): string[] {
  return persistedWindowsPathCache ? [...persistedWindowsPathCache.segments] : []
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
