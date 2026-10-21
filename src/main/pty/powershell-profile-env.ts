import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expandWindowsEnvironmentVariables } from '../../shared/windows-environment-expansion'
import { loadWindowsNativeRegistry } from '../windows-native-registry'
import { stripTrailingComment } from './shell-startup-env'

// Why both editions: a pane may run Windows PowerShell 5.1 or PowerShell 7, and
// each loads its own profiles. Within one, $PSHOME's load before the user's.
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
// Why `<>`: no Windows path holds them, so this never resolves to ~/.codex.
export const UNEVALUABLE_PROFILE_VALUE = '<unevaluable>'
const HOME_VARIABLES = /\$(?:HOME|env:USERPROFILE)(?!\w)|\$\{(?:HOME|env:USERPROFILE)\}/gi

const cache = new Map<string, string[]>()

/**
 * The value each PowerShell edition's profiles leave in `$env:<name>`, read as
 * text: the last assignment in load order wins, and an edition that never sets
 * it (or clears it) contributes nothing. Spawning PowerShell to evaluate the
 * profiles would run user code and reads as suspicious to EDR
 * (docs/reference/windows-edr-posture.md).
 *
 * Same fidelity as the POSIX rc-file probe: `$env:NAME = value`, `Set-Item` /
 * `New-Item env:NAME value` and `[Environment]::SetEnvironmentVariable('NAME',
 * value[, target])` lines; no conditionals or dot-sourced files. `$HOME` and
 * `$env:USERPROFILE` expand in double-quoted and bare values; any other
 * expression reads as UNEVALUABLE_PROFILE_VALUE. Preview and side-by-side
 * PowerShell 7 installs keep their all-users profile elsewhere and are not read.
 *
 * Memoized: profiles don't change under a running Orca often enough to pay a
 * re-read on every routing check.
 */
export function readPowerShellProfileEnvValues(name: string, userProfile: string): string[] {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    return []
  }
  const cacheKey = `${name.toLowerCase()}\0${userProfile}`
  const cached = cache.get(cacheKey)
  if (cached) {
    return cached
  }
  // Why every form, matched by its left side: a missed assignment fails open
  // onto ~/.codex, the #9788 bug, while an unparsable value still counts.
  const assignments = [
    `^(?:\\$env:${name}|\\$\\{env:${name}\\})\\s*=(?!=)(.*)$`,
    `^(?:Set|New)-Item\\s+(?:-Path\\s+)?['"]?env:\\\\?${name}['"]?(?=\\s|$)\\s*(?:-Value\\s+)?(.*)$`,
    // Why any target: 'User' and 'Machine' persist too, so counting them is the conservative read.
    `^\\[(?:System\\.)?Environment\\]::SetEnvironmentVariable\\(\\s*['"]${name}['"]\\s*,(.*?)(?:,\\s*(?:'[^']*'|"[^"]*"|[\\w.:[\\]]+)\\s*)?\\)$`
  ].map((source) => new RegExp(source, 'i'))
  // Why the registry: it names the folder PowerShell loads from, which OneDrive
  // or folder redirection may have moved; the default is only a fallback.
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

// Why the registry: $PROFILE hangs off the Documents known folder, which
// OneDrive or a policy can move anywhere; this is the same value it resolves.
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
    // Why: Windows PowerShell 5.1's `>` and Out-File write UTF-16LE with a BOM.
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
  // Why: other variables, subexpressions and calls can't be evaluated as text.
  const dynamic = doubleQuoted ? /[$`]/ : /[\s'"$`(){}@;,|&]/
  return dynamic.test(text.replace(HOME_VARIABLES, ''))
    ? UNEVALUABLE_PROFILE_VALUE
    : text.replace(HOME_VARIABLES, () => userProfile)
}

/** Test-only: profiles never change within a test process otherwise. */
export function __resetPowerShellProfileEnvCache(): void {
  cache.clear()
}
