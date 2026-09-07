import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { isAbsolute, relative } from 'node:path'
import { expandWindowsEnvironmentVariables } from '../../shared/windows-environment-expansion'

export function splitPathEntries(platform: NodeJS.Platform, value: string | null): string[] {
  if (!value) {
    return []
  }
  return value
    .split(platform === 'win32' ? ';' : ':')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

export function uniquePathEntries(platform: NodeJS.Platform, entries: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const entry of entries) {
    const key = platform === 'win32' ? normalizeWindowsPath(entry) : entry
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    result.push(entry)
  }
  return result
}

export function samePathEntry(
  platform: NodeJS.Platform,
  left: string,
  right: string,
  windowsEnvironment: NodeJS.ProcessEnv = process.env,
  expandWindowsVariables = true
): boolean {
  return platform === 'win32'
    ? normalizeWindowsPath(left, windowsEnvironment, expandWindowsVariables) ===
        normalizeWindowsPath(right, windowsEnvironment, expandWindowsVariables)
    : left === right
}

export function isPathInsideOrEqual(parentPath: string, childPath: string): boolean {
  const childRelative = relative(parentPath, childPath)
  return childRelative === '' || (!childRelative.startsWith('..') && !isAbsolute(childRelative))
}

export async function isExecutableFile(commandPath: string): Promise<boolean> {
  try {
    const stats = await stat(commandPath)
    if (!stats.isFile()) {
      return false
    }
    await access(commandPath, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function normalizeWindowsPath(
  value: string,
  env: NodeJS.ProcessEnv = process.env,
  expandEnvironmentVariables = true
): string {
  return (expandEnvironmentVariables ? expandWindowsEnvironmentVariables(value, env) : value)
    .replaceAll('/', '\\')
    .replace(/\\+$/, '')
    .toLowerCase()
}

export function escapeWindowsBatchValue(value: string): string {
  return value.replaceAll('"', '""')
}

export function quoteShell(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

export function isAbsoluteForPlatform(platform: NodeJS.Platform, value: string): boolean {
  if (platform === 'win32') {
    return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')
  }
  return isAbsolute(value)
}
