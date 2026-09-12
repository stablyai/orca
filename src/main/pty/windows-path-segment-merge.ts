import {
  expandWindowsEnvironmentVariables,
  expandWindowsPathEnvironmentVariables
} from '../../shared/windows-environment-expansion'

export function resolvePathEnvKey(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  platform: NodeJS.Platform,
  hostEnv: NodeJS.ProcessEnv = process.env
): string {
  if (platform !== 'win32') {
    return 'PATH'
  }
  // Why: match the daemon's env-block spelling so its merge cannot resurrect another PATH key.
  return firstWindowsPathEnvKey(env) ?? firstWindowsPathEnvKey(hostEnv) ?? 'Path'
}

// Why: Win32 uses the first case-insensitive key, and object order preserves block order.
function firstWindowsPathEnvKey(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>
): string | undefined {
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'path' && env[key] !== undefined) {
      return key
    }
  }
  return undefined
}

function normalizeSegmentKey(segment: string): string {
  const trimmed = segment.replace(/[\\/]+$/, '')
  // Why: roots keep one separator because `C:\` and drive-relative `C:` differ.
  return (/^[a-z]:$/i.test(trimmed) && trimmed !== segment ? `${trimmed}\\` : trimmed).toLowerCase()
}

function dedupeSegments(segments: string[]): string[] {
  const seen = new Set<string>()
  return segments.filter((segment) => {
    const key = normalizeSegmentKey(segment)
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}

function splitPathSegments(pathValue: string, pathDelimiter: string): string[] {
  return pathValue
    .split(pathDelimiter)
    .map((segment) => segment.trim())
    .filter(Boolean)
}

export function mergeWindowsPathSegments(
  env: NodeJS.ProcessEnv,
  persistedSegments: string[],
  platform: NodeJS.Platform,
  sourceEnv: NodeJS.ProcessEnv
): void {
  expandWindowsPathEnvironmentVariables(env, platform)
  const pathKey = resolvePathEnvKey(env, platform, sourceEnv)
  const pathDelimiter = platform === 'win32' ? ';' : ':'
  const currentPath =
    env[pathKey] ?? expandWindowsEnvironmentVariables(sourceEnv[pathKey] ?? '', sourceEnv)
  const currentSegments = splitPathSegments(currentPath, pathDelimiter)

  if (persistedSegments.length === 0) {
    return
  }

  const persisted = dedupeSegments(persistedSegments)
  const persistedKeys = new Set(persisted.map(normalizeSegmentKey))
  // Why: keep launch-time and Orca-injected entries that have no persisted position.
  const injected = dedupeSegments(
    currentSegments.filter((segment) => !persistedKeys.has(normalizeSegmentKey(segment)))
  )
  const merged = [...injected, ...persisted].join(pathDelimiter)

  if (merged !== currentPath) {
    env[pathKey] = merged
  }
}
