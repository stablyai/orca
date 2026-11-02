import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expandWindowsEnvironmentVariables } from '../../shared/windows-environment-expansion'
import { loadWindowsNativeRegistry } from '../windows-native-registry'
import { stripTrailingComment } from './shell-startup-env'

// Windows PowerShell and PowerShell 7 have separate profiles; all-users profiles precede user profiles.
const POWERSHELL_EDITIONS = [
  {
    documentsSubdir: 'WindowsPowerShell',
    psHome: () =>
      join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0')
  },
  {
    documentsSubdir: 'PowerShell',
    psHome: () => join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7')
  }
] as const
const PROFILE_FILES = ['profile.ps1', 'Microsoft.PowerShell_profile.ps1']
const USER_SHELL_FOLDERS_KEY =
  'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders'
// Invalid Windows path characters prevent unevaluable values from selecting ~/.codex.
export const UNEVALUABLE_PROFILE_VALUE = '<unevaluable>'
const HOME_VARIABLES = /\$(?:HOME|env:USERPROFILE)(?!\w)|\$\{(?:HOME|env:USERPROFILE)\}/gi

const cache = new Map<string, string[]>()

/** Read static assignments in profile order without executing user code or triggering EDR.
 * Supports env assignments, Set/New-Item and SetEnvironmentVariable; only HOME/USERPROFILE expand.
 * Dynamic expressions yield UNEVALUABLE_PROFILE_VALUE; conditionals, dot-sourcing and side-by-side/preview profiles are not evaluated.
 * Cache per process to keep routing checks cheap. */
export function readPowerShellProfileEnvValues(name: string, userProfile: string): string[] {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    return []
  }
  const cacheKey = `${name.toLowerCase()}\0${userProfile}`
  const cached = cache.get(cacheKey)
  if (cached) {
    return cached
  }
  // Recognize assignment LHS even when the value cannot parse; missing it would fail open to ~/.codex (#9788).
  const assignments = [
    `^(?:\\$env:${name}|\\$\\{env:${name}\\})\\s*=(?!=)(.*)$`,
    `^(?:Set|New)-Item\\s+(?:-Path\\s+)?['"]?env:\\\\?${name}['"]?(?=\\s|$)\\s*(?:-Value\\s+)?(.*)$`,
    // User/Machine targets also persist values; count them conservatively.
    `^\\[(?:System\\.)?Environment\\]::SetEnvironmentVariable\\(\\s*['"]${name}['"]\\s*,(.*?)(?:,\\s*(?:'[^']*'|"[^"]*"|[\\w.:[\\]]+)\\s*)?\\)$`
  ].map((source) => new RegExp(source, 'i'))
  // Registry Documents follows OneDrive/policy redirection, matching $PROFILE.
  const documentsDir = readRegistryDocumentsDir() ?? join(userProfile, 'Documents')
  const values = POWERSHELL_EDITIONS.map((edition) => {
    let last = ''
    const profilePaths = [
      ...PROFILE_FILES.map((file) => join(edition.psHome(), file)),
      ...PROFILE_FILES.map((file) => join(documentsDir, edition.documentsSubdir, file))
    ]
    for (const path of profilePaths) {
      for (const line of readProfile(path)?.split(/\r?\n/) ?? []) {
        const statement = stripTrailingComment(line).trim().replace(/;$/, '')
        const value = assignments.map((form) => form.exec(statement)?.[1]).find(Boolean)
        if (value !== undefined) {
          last = parsePowerShellValue(value, userProfile)
        }
      }
    }
    return last
  }).filter(Boolean)
  cache.set(cacheKey, values)
  return values
}

function readRegistryDocumentsDir(): string | null {
  try {
    const registry = loadWindowsNativeRegistry()
    const personal = registry.getRegistryKey(registry.HK.CU, USER_SHELL_FOLDERS_KEY)?.Personal
    return typeof personal?.value === 'string'
      ? expandWindowsEnvironmentVariables(personal.value, process.env)
      : null
  } catch {
    return null
  }
}

function readProfile(path: string): string | null {
  try {
    const bytes = readFileSync(path)
    // Windows PowerShell 5.1 redirection writes BOM-prefixed UTF-16LE.
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      return bytes.subarray(2).toString('utf16le')
    }
    return bytes.toString('utf8').replace(/^\uFEFF/, '')
  } catch {
    return null
  }
}

function parsePowerShellValue(raw: string, userProfile: string): string {
  const value = raw.trim()
  if (/^\$null$/i.test(value)) {
    return ''
  }
  const singleQuoted = /^'((?:[^']|'')*)'$/.exec(value)
  if (singleQuoted) {
    return singleQuoted[1].replaceAll("''", "'")
  }
  const doubleQuoted = /^"([^"]*)"$/.exec(value)
  const text = doubleQuoted?.[1] ?? value
  // Other variables and expressions require execution; retain them as unevaluable.
  const dynamic = doubleQuoted ? /[$`]/ : /[\s'"$`(){}@;,|&]/
  return dynamic.test(text.replace(HOME_VARIABLES, ''))
    ? UNEVALUABLE_PROFILE_VALUE
    : text.replace(HOME_VARIABLES, () => userProfile)
}

export function __resetPowerShellProfileEnvCache(): void {
  cache.clear()
}
