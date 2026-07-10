import { execFileSync } from 'node:child_process'

type ExecFileSync = typeof execFileSync

type ReadWindowsPathOptions = {
  execFileSync?: ExecFileSync
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
}

const WINDOWS_PATH_REGISTRY_KEYS = [
  ['HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', 'Path'],
  ['HKCU\\Environment', 'Path']
] as const

const PERSISTED_WINDOWS_PATH_CACHE_TTL_MS = 30_000

let persistedWindowsPathCache:
  | {
      readAt: number
      segments: string[]
    }
  | undefined

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

function expandWindowsEnvironmentVariables(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/%([^%]+)%/g, (match, rawName: string) => {
    const name = rawName.toLowerCase()
    const envKey = Object.keys(env).find((key) => key.toLowerCase() === name)
    return envKey && env[envKey] ? env[envKey] : match
  })
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

export function readPersistedWindowsPathSegments(options: ReadWindowsPathOptions = {}): string[] {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') {
    return []
  }

  const useProductionCache =
    options.execFileSync === undefined &&
    options.env === undefined &&
    options.platform === undefined
  const now = Date.now()
  if (
    useProductionCache &&
    persistedWindowsPathCache &&
    now - persistedWindowsPathCache.readAt < PERSISTED_WINDOWS_PATH_CACHE_TTL_MS
  ) {
    return [...persistedWindowsPathCache.segments]
  }

  const run = options.execFileSync ?? execFileSync
  const env = options.env ?? process.env
  const pathDelimiter = getPathDelimiter(platform)
  const segments: string[] = []

  for (const [key, valueName] of WINDOWS_PATH_REGISTRY_KEYS) {
    try {
      const output = run('reg.exe', ['query', key, '/v', valueName], {
        encoding: 'utf8',
        windowsHide: true
      })
      const value = parseRegistryPathValue(output, valueName)
      if (value) {
        segments.push(
          ...splitPathSegments(expandWindowsEnvironmentVariables(value, env), pathDelimiter)
        )
      }
    } catch {
      // Registry access can fail in stripped test containers or remote-like
      // Windows contexts. Existing PATH remains the fallback in those cases.
    }
  }

  if (useProductionCache) {
    // Why: local PTY spawn is a hot path on Windows, and each uncached read
    // runs two synchronous `reg.exe query` subprocesses. A short TTL keeps
    // terminal bursts cheap while still picking up newly installed CLIs soon.
    persistedWindowsPathCache = {
      readAt: now,
      segments: [...segments]
    }
  }

  return segments
}

export function __resetPersistedWindowsPathCacheForTests(): void {
  persistedWindowsPathCache = undefined
}

export function mergePersistedWindowsPath(
  env: NodeJS.ProcessEnv,
  options: ReadWindowsPathOptions = {}
): void {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') {
    return
  }

  const pathKey = env.Path !== undefined ? 'Path' : env.PATH !== undefined ? 'PATH' : 'Path'
  const pathDelimiter = getPathDelimiter(platform)
  const sourceEnv = options.env ?? process.env
  const currentPath = env[pathKey] ?? sourceEnv.PATH ?? sourceEnv.Path ?? ''
  const currentSegments = splitPathSegments(currentPath, pathDelimiter)
  const existing = new Set(currentSegments.map((segment) => segment.toLowerCase()))
  const missing = readPersistedWindowsPathSegments(options).filter((segment) => {
    const normalized = segment.toLowerCase()
    if (existing.has(normalized)) {
      return false
    }
    existing.add(normalized)
    return true
  })

  if (missing.length === 0) {
    return
  }

  // Why: Windows broadcasts PATH changes to future processes, but a running
  // Electron app keeps its old environment. Append the persisted additions so
  // newly installed CLIs resolve without unexpectedly reordering existing PATH.
  env[pathKey] = [...currentSegments, ...missing].join(pathDelimiter)
}
