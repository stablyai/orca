import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  readVerifiedShebangInterpreter,
  renderLegacyTerminalPosixTombstone,
  resolvePosixTombstoneInterpreter
} from './legacy-terminal-posix-tombstone'
import {
  renderLegacyTerminalWindowsCmdTombstone,
  renderLegacyTerminalWindowsPowerShellTombstone
} from './legacy-terminal-windows-tombstone'

const LEGACY_TERMINAL_ATTRIBUTION_ENABLE_ENV_KEY = 'ORCA_ENABLE_GIT_ATTRIBUTION'
const LEGACY_TERMINAL_ATTRIBUTION_BYPASS_ENV_KEY = 'ORCA_ATTRIBUTION_BYPASS'

const LEGACY_SHIM_ROOT_DIR = 'orca-terminal-attribution'
// Distinguish retired version 7 so rollback rewrites tombstones instead of treating them as active wrappers.
const LEGACY_SHIM_VERSION = '7-neutralized'
const NEUTRALIZATION_RETRY_DELAYS_MS = [1_000, 5_000, 15_000, 30_000]
export const LEGACY_TERMINAL_SHIM_ENV_KEYS = [
  'ORCA_ENABLE_GIT_ATTRIBUTION',
  'ORCA_GIT_COMMIT_TRAILER',
  'ORCA_GH_PR_FOOTER',
  'ORCA_GH_ISSUE_FOOTER',
  'ORCA_ATTRIBUTION_SHIM_DIR',
  'ORCA_REAL_GIT',
  'ORCA_REAL_GH',
  LEGACY_TERMINAL_ATTRIBUTION_BYPASS_ENV_KEY
] as const
export const LEGACY_TERMINAL_SHIM_REMOTE_ENV_KEYS = [
  LEGACY_TERMINAL_ATTRIBUTION_ENABLE_ENV_KEY
] as const

let neutralized = false
let neutralizationRetryTimer: ReturnType<typeof setTimeout> | null = null
let neutralizationRetryAttempt = 0

export function neutralizeLegacyTerminalShimDir(userDataPath: string): void {
  if (neutralized) {
    return
  }
  const rootDir = join(userDataPath, LEGACY_SHIM_ROOT_DIR)
  // Only existing installs need tombstones to keep hashed wrapper paths alive.
  if (!existsSync(rootDir)) {
    neutralized = true
    clearNeutralizationRetry()
    return
  }
  try {
    writeNeutralWrappers(rootDir)
    writeFileAtomically(join(rootDir, 'VERSION'), `${LEGACY_SHIM_VERSION}\n`, 0o644)
    neutralized = true
    clearNeutralizationRetry()
  } catch (error) {
    // Running .cmd files may remain locked briefly on Windows.
    console.warn(
      `[legacy-terminal-shim] neutralization attempt ${neutralizationRetryAttempt + 1} failed:`,
      error instanceof Error ? error.message : String(error)
    )
    scheduleNeutralizationRetry(userDataPath)
  }
}

function scheduleNeutralizationRetry(userDataPath: string): void {
  if (neutralizationRetryTimer) {
    return
  }
  if (neutralizationRetryAttempt >= NEUTRALIZATION_RETRY_DELAYS_MS.length) {
    // Report exhaustion; +1 includes the initial attempt before retries.
    console.warn(
      `[legacy-terminal-shim] gave up neutralizing after ${neutralizationRetryAttempt + 1} attempts; legacy git/gh wrappers may remain until the next launch`
    )
    return
  }
  const delayMs = NEUTRALIZATION_RETRY_DELAYS_MS[neutralizationRetryAttempt]
  neutralizationRetryAttempt += 1
  neutralizationRetryTimer = setTimeout(() => {
    neutralizationRetryTimer = null
    neutralizeLegacyTerminalShimDir(userDataPath)
  }, delayMs)
  neutralizationRetryTimer.unref?.()
}

function clearNeutralizationRetry(): void {
  if (neutralizationRetryTimer) {
    clearTimeout(neutralizationRetryTimer)
    neutralizationRetryTimer = null
  }
  neutralizationRetryAttempt = 0
}

function writeNeutralWrappers(rootDir: string): void {
  const posixDir = join(rootDir, 'posix')
  const win32Dir = join(rootDir, 'win32')
  mkdirSync(posixDir, { recursive: true })
  mkdirSync(win32Dir, { recursive: true })
  // Prefer a verified replacement shebang: deleting a hashed wrapper strands shells at 127; ambient lookup permits cwd hijacking.
  const interpreter = resolvePosixTombstoneInterpreter()
  for (const command of ['git', 'gh'] as const) {
    const posixPath = join(posixDir, command)
    const resolved = interpreter ?? readVerifiedShebangInterpreter(posixPath)
    if (resolved === null) {
      rmSync(posixPath, { force: true })
    } else {
      writeFileAtomically(posixPath, renderLegacyTerminalPosixTombstone(command, resolved), 0o755)
    }
    writeFileAtomically(
      join(win32Dir, `${command}.cmd`),
      renderLegacyTerminalWindowsCmdTombstone(command),
      0o755
    )
    writeFileAtomically(
      join(win32Dir, `${command}-wrapper.ps1`),
      renderLegacyTerminalWindowsPowerShellTombstone(command),
      0o755
    )
  }
}

function writeFileAtomically(filePath: string, contents: string, mode: number): void {
  const temporaryPath = `${filePath}.orca-neutralizing-${process.pid}`
  try {
    rmSync(temporaryPath, { force: true, recursive: true })
    writeFileSync(temporaryPath, contents, { encoding: 'utf8', flag: 'wx', mode })
    chmodSync(temporaryPath, mode)
    renameSync(temporaryPath, filePath)
  } finally {
    try {
      rmSync(temporaryPath, { force: true, recursive: true })
    } catch {
      // Cleanup failure must not mask the original write error.
    }
  }
}

// Preserve literal removal for paths containing PATH delimiters; also account for slash style and trailing separators.
function pathEntrySpellings(dir: string, windows: boolean): string[] {
  const base = stripTrailingSeparators(dir, windows)
  if (!base) {
    return [dir]
  }
  const spellings = new Set<string>([dir, base, `${base}/`])
  if (windows) {
    spellings.add(`${base}\\`)
  }
  return [...spellings]
}

// Keep .. lexical: collapsing through a symlink can erase a real PATH entry, and remote/WSL paths cannot be resolved locally.
// Missed legacy spellings remain safe because tombstones exclude their directory by inode.
export function isLegacyTerminalShimPathEntry(entry: string): boolean {
  // Remote Windows env can reach any host; recognize both slash styles in Orca's fixed layout.
  const normalized = stripTrailingSeparators(entry.replaceAll('\\', '/'), true).toLowerCase()
  return (
    normalized.endsWith(`/${LEGACY_SHIM_ROOT_DIR}/posix`) ||
    normalized.endsWith(`/${LEGACY_SHIM_ROOT_DIR}/win32`)
  )
}

// Strip repeated separators, but preserve POSIX backslashes as filename characters.
function stripTrailingSeparators(value: string, windows: boolean): string {
  return value.replace(windows ? /[\\/]+$/ : /\/+$/, '')
}

function namesCapturedShimDir(entry: string, shimDirs: string[], windows: boolean): boolean {
  const candidate = stripTrailingSeparators(entry, windows)
  return shimDirs.some((shimDir) => {
    const target = stripTrailingSeparators(shimDir, windows)
    return target
      ? windows
        ? candidate.toLowerCase() === target.toLowerCase()
        : candidate === target
      : false
  })
}

export function stripLegacyTerminalShimEnv(
  env: Record<string, string>,
  platform: NodeJS.Platform = process.platform
): void {
  const windows = platform === 'win32'
  const legacyKeySet = new Set(
    LEGACY_TERMINAL_SHIM_ENV_KEYS.map((key) => (windows ? key.toLowerCase() : key))
  )
  const shimDirKey = 'ORCA_ATTRIBUTION_SHIM_DIR'.toLowerCase()
  const explicitShimDirs = Object.entries(env)
    .filter(([key]) =>
      windows ? key.toLowerCase() === shimDirKey : key === 'ORCA_ATTRIBUTION_SHIM_DIR'
    )
    .map(([, value]) => value)
    .filter(Boolean)
  for (const key of Object.keys(env)) {
    if (windows ? legacyKeySet.has(key.toLowerCase()) : legacyKeySet.has(key)) {
      delete env[key]
    }
  }
  const delimiter = windows ? ';' : ':'
  const pathKeys = windows
    ? Object.keys(env).filter((key) => key.toLowerCase() === 'path')
    : ['PATH']
  for (const pathKey of pathKeys) {
    const current = env[pathKey]
    if (!current) {
      continue
    }
    const withoutExplicitDirs = explicitShimDirs.reduce(
      (pathValue, shimDir) =>
        pathEntrySpellings(shimDir, windows).reduce(
          (value, spelling) => removeLiteralPathEntry(value, spelling, delimiter, windows),
          pathValue
        ),
      current
    )
    const cleaned = withoutExplicitDirs
      .split(delimiter)
      .filter(
        (entry) =>
          entry &&
          !isLegacyTerminalShimPathEntry(entry) &&
          !namesCapturedShimDir(entry, explicitShimDirs, windows)
      )
      .join(delimiter)
    if (cleaned) {
      env[pathKey] = cleaned
    } else {
      delete env[pathKey]
    }
  }
}

function removeLiteralPathEntry(
  pathValue: string,
  entry: string,
  delimiter: string,
  caseInsensitive: boolean
): string {
  let result = pathValue
  const needle = caseInsensitive ? entry.toLowerCase() : entry
  let searchStart = 0
  for (;;) {
    const comparable = caseInsensitive ? result.toLowerCase() : result
    const index = comparable.indexOf(needle, searchStart)
    if (index === -1) {
      return result
    }
    const end = index + entry.length
    const startsAtBoundary = index === 0 || result[index - 1] === delimiter
    const endsAtBoundary = end === result.length || result[end] === delimiter
    if (!startsAtBoundary || !endsAtBoundary) {
      searchStart = index + 1
      continue
    }
    if (result[end] === delimiter) {
      result = result.slice(0, index) + result.slice(end + 1)
    } else if (index > 0) {
      result = result.slice(0, index - 1) + result.slice(end)
    } else {
      result = ''
    }
    searchStart = Math.max(0, index - 1)
  }
}

export function __resetLegacyTerminalShimNeutralizationForTests(): void {
  neutralized = false
  clearNeutralizationRetry()
}
