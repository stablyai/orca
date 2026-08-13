import { existsSync } from 'node:fs'
import { win32 } from 'node:path'
import {
  loadWindowsNativeRegistry,
  WINDOWS_REG_EXPAND_SZ,
  type WindowsNativeRegistryModule
} from '../windows-native-registry'
import { getWindowsPowerShellExePath } from '../win32-utils'
import type { OpenWithApplicationCandidate } from './open-with-candidate'
import { readOpenWithCommandOutput } from './open-with-command-output'

const FILE_EXTS_KEY_PREFIX = 'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts'
const CLASSES_KEY_PREFIX = 'Software\\Classes'
const DESCRIPTION_LOOKUP_TIMEOUT_MS = 5_000

type WindowsOpenCommand = {
  command: string
  isDefault: boolean
}

/** Discovers the applications registered for a file extension in the Windows registry. */
export async function listWindowsOpenWithApplications(
  filePath: string
): Promise<OpenWithApplicationCandidate[]> {
  const extension = win32.extname(filePath).toLowerCase()
  if (!extension) {
    return []
  }
  let registry: WindowsNativeRegistryModule
  try {
    registry = loadWindowsNativeRegistry()
  } catch {
    return []
  }

  const candidatesByExecutable = new Map<
    string,
    OpenWithApplicationCandidate & { executablePath: string }
  >()
  for (const openCommand of collectWindowsOpenCommands(registry, extension)) {
    const executablePath = extractWindowsExecutablePath(openCommand.command)
    if (!executablePath || !existsSync(executablePath)) {
      continue
    }
    const executableKey = executablePath.toLowerCase()
    const existing = candidatesByExecutable.get(executableKey)
    if (existing) {
      // Why: two ProgIds can share an exe with different command lines; the
      // default handler's line wins so the launch matches the Default label.
      if (openCommand.isDefault && !existing.isDefault) {
        existing.isDefault = true
        existing.launch = { kind: 'windows-command', command: openCommand.command }
      }
      continue
    }
    candidatesByExecutable.set(executableKey, {
      id: `windows:${executableKey}`,
      name: fallbackWindowsApplicationName(executablePath),
      isDefault: openCommand.isDefault,
      executablePath,
      launch: { kind: 'windows-command', command: openCommand.command }
    })
  }

  const candidates = [...candidatesByExecutable.values()]
  await applyWindowsFileDescriptions(candidates)
  return candidates.map(({ executablePath: _executablePath, ...candidate }) => candidate)
}

/** Collects an extension's open command lines from UserChoice, OpenWithProgids and OpenWithList. */
function collectWindowsOpenCommands(
  registry: WindowsNativeRegistryModule,
  extension: string
): WindowsOpenCommand[] {
  const { HK } = registry
  const fileExtsKey = `${FILE_EXTS_KEY_PREFIX}\\${extension}`
  const userChoiceProgid = readRegistryString(
    registry,
    HK.CU,
    `${fileExtsKey}\\UserChoice`,
    'ProgId'
  )

  // Why: HKCR is the merged view of these two hives; the native module only
  // exposes HKCU/HKLM roots, so read both Software\Classes branches directly.
  const progids = new Set<string>()
  for (const root of [HK.CU, HK.LM]) {
    const defaultProgid = readRegistryString(
      registry,
      root,
      `${CLASSES_KEY_PREFIX}\\${extension}`,
      ''
    )
    if (defaultProgid) {
      progids.add(defaultProgid)
    }
    for (const name of readRegistryValueNames(
      registry,
      root,
      `${CLASSES_KEY_PREFIX}\\${extension}\\OpenWithProgids`
    )) {
      progids.add(name)
    }
  }
  for (const name of readRegistryValueNames(registry, HK.CU, `${fileExtsKey}\\OpenWithProgids`)) {
    progids.add(name)
  }
  if (userChoiceProgid) {
    progids.add(userChoiceProgid)
  }

  const commands: WindowsOpenCommand[] = []
  for (const progid of progids) {
    const command = readClassOpenCommand(registry, `${progid}\\shell\\open\\command`)
    if (command) {
      commands.push({ command, isDefault: progid === userChoiceProgid })
    }
  }
  for (const executableName of readWindowsOpenWithListExecutables(registry, fileExtsKey)) {
    const command = readClassOpenCommand(
      registry,
      `Applications\\${executableName}\\shell\\open\\command`
    )
    if (command) {
      commands.push({ command, isDefault: false })
    }
  }
  return commands
}

/** Reads the OpenWithList executable names, ignoring the MRU ordering value. */
function readWindowsOpenWithListExecutables(
  registry: WindowsNativeRegistryModule,
  fileExtsKey: string
): string[] {
  const openWithList = registry.getRegistryKey(registry.HK.CU, `${fileExtsKey}\\OpenWithList`)
  const executableNames: string[] = []
  for (const [valueName, entry] of Object.entries(openWithList ?? {})) {
    if (valueName.toLowerCase() === 'mrulist' || typeof entry?.value !== 'string') {
      continue
    }
    executableNames.push(entry.value)
  }
  return executableNames
}

/** Reads a ProgId's shell\open\command line from one hive. */
function readClassOpenCommand(
  registry: WindowsNativeRegistryModule,
  classSubkeyPath: string
): string | null {
  for (const root of [registry.HK.CU, registry.HK.LM]) {
    const command = readRegistryString(
      registry,
      root,
      `${CLASSES_KEY_PREFIX}\\${classSubkeyPath}`,
      ''
    )
    if (command?.trim()) {
      return command.trim()
    }
  }
  return null
}

/** Reads one registry string value, or null when the key, value or type does not match. */
function readRegistryString(
  registry: WindowsNativeRegistryModule,
  root: number,
  keyPath: string,
  valueName: string
): string | null {
  let key: ReturnType<WindowsNativeRegistryModule['getRegistryKey']>
  try {
    key = registry.getRegistryKey(root, keyPath)
  } catch {
    return null
  }
  const entry = key?.[valueName]
  if (typeof entry?.value !== 'string') {
    return null
  }
  return entry.type === WINDOWS_REG_EXPAND_SZ
    ? expandWindowsEnvironmentVariables(entry.value)
    : entry.value
}

/** Lists a registry key's value names; empty when the key is missing. */
function readRegistryValueNames(
  registry: WindowsNativeRegistryModule,
  root: number,
  keyPath: string
): string[] {
  try {
    return Object.keys(registry.getRegistryKey(root, keyPath) ?? {}).filter(Boolean)
  } catch {
    return []
  }
}

/** Expands %VAR% references while leaving argument placeholders such as %1 intact. */
export function expandWindowsEnvironmentVariables(
  value: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  // Why: %1-style launch placeholders never resolve as env vars, so unknown
  // names must survive expansion untouched.
  return value.replace(/%([^%]+)%/g, (match, name: string) => env[name] ?? match)
}

/** Extracts the executable path from a registry command line. */
export function extractWindowsExecutablePath(
  command: string,
  fileExists: (path: string) => boolean = existsSync
): string | null {
  const trimmed = command.trim()
  if (!trimmed) {
    return null
  }
  if (trimmed.startsWith('"')) {
    const closingQuote = trimmed.indexOf('"', 1)
    return closingQuote > 1 ? trimmed.slice(1, closingQuote) : null
  }
  // Why: registry commands may leave a spaced executable path unquoted
  // (`C:\Program Files\App\app.exe "%1"`); probe progressively longer prefixes.
  const tokens = trimmed.split(/\s+/)
  let prefix = ''
  for (const token of tokens) {
    prefix = prefix ? `${prefix} ${token}` : token
    if (/\.exe$/i.test(prefix) && fileExists(prefix)) {
      return prefix
    }
  }
  return /\.exe$/i.test(tokens[0] ?? '') ? tokens[0] : null
}

/** Builds the spawn command and argv for a registry command line and target path. */
export function buildWindowsLaunchInvocation(
  command: string,
  filePath: string,
  fileExists: (path: string) => boolean = existsSync
): { spawnCmd: string; spawnArgs: string[] } | null {
  const executablePath = extractWindowsExecutablePath(command, fileExists)
  if (!executablePath) {
    return null
  }
  const trimmed = command.trim()
  const argsText = trimmed.startsWith('"')
    ? trimmed.slice(trimmed.indexOf('"', 1) + 1)
    : trimmed.slice(executablePath.length)

  const spawnArgs: string[] = []
  let placeholderUsed = false
  for (const token of tokenizeWindowsCommandArguments(argsText)) {
    // Why: shell verbs substitute the target into %1/%l (path) and %u/%v (URL
    // or path) alike — Office registers `"%1" /ou "%u"` and expects both filled.
    if (/^%[1lLuUvV]$/.test(token)) {
      spawnArgs.push(filePath)
      placeholderUsed = true
      continue
    }
    if (/^%(\*|\d+)$/.test(token)) {
      continue
    }
    if (/%[1lLuUvV](?![A-Za-z0-9_%])/.test(token)) {
      spawnArgs.push(token.replace(/%[1lLuUvV](?![A-Za-z0-9_%])/g, () => filePath))
      placeholderUsed = true
      continue
    }
    spawnArgs.push(token)
  }
  if (!placeholderUsed) {
    spawnArgs.push(filePath)
  }
  return { spawnCmd: executablePath, spawnArgs }
}

/** Splits a command line's argument tail, honoring double-quoted spans. */
function tokenizeWindowsCommandArguments(argsText: string): string[] {
  const tokens: string[] = []
  const tokenPattern = /"([^"]*)"|(\S+)/g
  let match: RegExpExecArray | null
  while ((match = tokenPattern.exec(argsText)) !== null) {
    tokens.push(match[1] ?? match[2])
  }
  return tokens
}

/** Display name derived from the executable file name, used when FileDescription is unavailable. */
export function fallbackWindowsApplicationName(executablePath: string): string {
  const baseName = win32.basename(executablePath).replace(/\.exe$/i, '')
  return baseName ? baseName.charAt(0).toUpperCase() + baseName.slice(1) : executablePath
}

/** Replaces candidate names with each executable's FileDescription where one is available. */
async function applyWindowsFileDescriptions(
  candidates: (OpenWithApplicationCandidate & { executablePath: string })[]
): Promise<void> {
  if (candidates.length === 0) {
    return
  }
  const quotedPaths = candidates
    .map((candidate) => `'${candidate.executablePath.replace(/'/g, "''")}'`)
    .join(', ')
  // Why: PowerShell 5.1 emits redirected stdout in the OEM code page; pin UTF-8
  // or localized app descriptions arrive as mojibake.
  const script = `
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$results = foreach ($p in @(${quotedPaths})) {
  try {
    $d = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($p).FileDescription
    if ($d) { [PSCustomObject]@{ path = $p; description = $d.Trim() } }
  } catch {}
}
ConvertTo-Json -InputObject @($results) -Compress
`
  let entries: { path?: unknown; description?: unknown }[]
  try {
    const output = await readOpenWithCommandOutput(
      getWindowsPowerShellExePath(),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      DESCRIPTION_LOOKUP_TIMEOUT_MS
    )
    const parsed: unknown = JSON.parse(output)
    entries = Array.isArray(parsed) ? parsed : []
  } catch {
    return
  }
  const descriptionsByPath = new Map<string, string>()
  for (const entry of entries) {
    if (typeof entry?.path === 'string' && typeof entry.description === 'string') {
      descriptionsByPath.set(entry.path.toLowerCase(), entry.description)
    }
  }
  for (const candidate of candidates) {
    const description = descriptionsByPath.get(candidate.executablePath.toLowerCase())
    if (description) {
      candidate.name = description
    }
  }
}
