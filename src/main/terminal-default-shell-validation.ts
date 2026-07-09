import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import {
  normalizeTerminalDefaultShellPath,
  type TerminalDefaultShellValidationCode,
  type TerminalDefaultShellValidationResult
} from '../shared/terminal-default-shell'

const RECOGNIZED_POSIX_SHELL_NAMES = new Set([
  'sh',
  'bash',
  'zsh',
  'fish',
  'dash',
  'ash',
  'ksh',
  'mksh',
  'pdksh',
  'oksh',
  'yash',
  'csh',
  'tcsh',
  'elvish',
  'nu',
  'nushell',
  'xonsh',
  'pwsh'
])

let systemShellPathsCache: Set<string> | null = null
let systemShellRealpathsCache: Set<string> | null = null

function failure(
  code: TerminalDefaultShellValidationCode,
  message: string
): TerminalDefaultShellValidationResult {
  return { ok: false, code, message }
}

function getSystemShellPaths(): Set<string> {
  if (systemShellPathsCache) {
    return systemShellPathsCache
  }
  const paths = new Set<string>()
  try {
    for (const line of readFileSync('/etc/shells', 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed && !trimmed.startsWith('#')) {
        paths.add(trimmed)
      }
    }
  } catch {
    // /etc/shells is not guaranteed in minimal containers; basename fallback
    // below still blocks arbitrary binaries like editors or language runtimes.
  }
  systemShellPathsCache = paths
  return paths
}

function getSystemShellRealpaths(): Set<string> {
  if (systemShellRealpathsCache) {
    return systemShellRealpathsCache
  }
  const realpaths = new Set<string>()
  for (const shellPath of getSystemShellPaths()) {
    try {
      realpaths.add(realpathSync(shellPath))
    } catch {
      // Ignore stale /etc/shells entries.
    }
  }
  systemShellRealpathsCache = realpaths
  return realpaths
}

function isRecognizedShell(shellPath: string): boolean {
  if (getSystemShellPaths().has(shellPath)) {
    return true
  }
  try {
    if (getSystemShellRealpaths().has(realpathSync(shellPath))) {
      return true
    }
  } catch {
    return false
  }
  return RECOGNIZED_POSIX_SHELL_NAMES.has(basename(shellPath).toLowerCase())
}

export function validateTerminalDefaultShellPath(
  value: unknown
): TerminalDefaultShellValidationResult {
  if (value === null || value === undefined) {
    return { ok: true, shellPath: null }
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { ok: true, shellPath: null }
  }

  const shellPath = normalizeTerminalDefaultShellPath(value)
  if (!shellPath) {
    return failure(
      'not-posix-absolute',
      'Use a POSIX absolute shell path, such as /bin/zsh or /usr/bin/fish.'
    )
  }
  if (process.platform === 'win32') {
    return failure(
      'unsupported-platform',
      'Custom POSIX default shells are only supported on macOS and Linux.'
    )
  }

  try {
    const stats = statSync(shellPath)
    if (!stats.isFile()) {
      return failure('not-file', `Shell "${shellPath}" is not a file.`)
    }
  } catch {
    return failure('not-found', `Shell "${shellPath}" does not exist.`)
  }

  try {
    accessSync(shellPath, constants.X_OK)
  } catch {
    return failure('not-executable', `Shell "${shellPath}" is not executable.`)
  }

  if (!isRecognizedShell(shellPath)) {
    return failure(
      'not-recognized-shell',
      `Shell "${shellPath}" is not a recognized shell. Choose bash, zsh, fish, sh, ksh, dash, tcsh, csh, or a path listed in /etc/shells.`
    )
  }

  return { ok: true, shellPath }
}

export function requireValidTerminalDefaultShellPath(value: unknown): string | null {
  const validation = validateTerminalDefaultShellPath(value)
  if (!validation.ok) {
    throw new Error(validation.message)
  }
  return validation.shellPath
}

export function requireValidPosixShellOverrideForSpawn(value: unknown): string | undefined {
  const shellPath = normalizeTerminalDefaultShellPath(value)
  if (!shellPath) {
    return undefined
  }
  return requireValidTerminalDefaultShellPath(shellPath) ?? undefined
}

export function getLaunchablePosixShellOverrideForSpawn(value: unknown): string | undefined {
  const shellPath = normalizeTerminalDefaultShellPath(value)
  if (!shellPath) {
    return undefined
  }
  const validation = validateTerminalDefaultShellPath(shellPath)
  // Why: a persisted shell path can disappear after settings validation; spawn
  // should fall back to the host shell instead of failing to open a terminal.
  return validation.ok ? (validation.shellPath ?? undefined) : undefined
}
