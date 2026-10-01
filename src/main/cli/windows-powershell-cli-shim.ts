import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { runProcess } from '../../shared/child-process/run-process'
import { windowsPowerShellPath } from '../../shared/child-process/windows-system-binary'
import type { CliInstallerOptions } from './cli-installer-contracts'

export const ORCA_POWERSHELL_SHIM_BEGIN = '# >>> orca cli utf-8 shim >>>'
export const ORCA_POWERSHELL_SHIM_END = '# <<< orca cli utf-8 shim <<<'

// Why the line anchor: `\borca\b` also matches `function orca-tools` and comments.
const USER_ORCA_FUNCTION = /^[ \t]*function[ \t]+(?:[A-Za-z]+:)?orca[ \t]*(?:$|[({])/im

export type WindowsPowerShellCliShimStatus =
  | 'installed'
  | 'removed'
  | 'skipped-user-function'
  | 'skipped-undecodable-profile'

type ProfileEncoding = 'utf8' | 'utf8-bom' | 'utf16le'

/**
 * Why not every `new CliInstaller({ platform: 'win32' })`: those are tests, and
 * resolving MyDocuments would rewrite the machine profile (#24428).
 */
export function shouldManageWindowsPowerShellCliShim(options: CliInstallerOptions): boolean {
  if (options.syncWindowsPowerShellProfile !== undefined) {
    return options.syncWindowsPowerShellProfile
  }
  return (
    options.platform === undefined &&
    options.userPathReader === undefined &&
    options.userDataPath === undefined
  )
}

export function windowsPowerShell51ProfilePath(documentsPath: string): string {
  return join(documentsPath, 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1')
}

export function defaultWindowsPowerShellShimPath(localAppDataPath: string): string {
  return join(localAppDataPath, 'Orca', 'cli', 'orca-powershell-shim.ps1')
}

export function renderOrcaPowerShellCliShim(launcherPath: string): string {
  const quotedLauncher = powershellSingleQuote(launcherPath)
  return [
    '# Why: Windows PowerShell 5.1 encodes a pipeline into a native exe with',
    '# $OutputEncoding, which defaults to US-ASCII and turns non-ASCII into "?".',
    '# A function receives the pipeline as text and can re-encode it (#24428).',
    'function global:orca {',
    `  $launcher = ${quotedLauncher}`,
    '  if (-not (Test-Path -LiteralPath $launcher)) {',
    '    # Why no PATH search: another orca.exe would receive the pipe (#24428).',
    '    [Console]::Error.WriteLine("Orca CLI launcher is missing at $launcher")',
    '    $global:LASTEXITCODE = 1',
    '    return',
    '  }',
    '  if ($MyInvocation.ExpectingInput) {',
    '    $OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    '    $input | & $launcher @args',
    '    return',
    '  }',
    '  & $launcher @args',
    '}',
    ''
  ].join('\n')
}

export function renderOrcaPowerShellProfileBlock(shimPath: string): string {
  const quotedShim = powershellSingleQuote(shimPath)
  return [
    ORCA_POWERSHELL_SHIM_BEGIN,
    `if (Test-Path -LiteralPath ${quotedShim}) { . ${quotedShim} }`,
    ORCA_POWERSHELL_SHIM_END
  ].join('\n')
}

export function profileHasUserOrcaFunction(profile: string): boolean {
  return USER_ORCA_FUNCTION.test(removeManagedProfileBlock(profile))
}

function managedBlockPattern(): RegExp {
  return new RegExp(
    `${escapeRegExp(ORCA_POWERSHELL_SHIM_BEGIN)}[\\s\\S]*?${escapeRegExp(ORCA_POWERSHELL_SHIM_END)}\\r?\\n?`,
    'g'
  )
}

export function removeManagedProfileBlock(profile: string): string {
  return profile.replace(managedBlockPattern(), '')
}

export function upsertManagedProfileBlock(profile: string, block: string): string {
  if (profileHasUserOrcaFunction(profile)) {
    return 'skipped-user-function'
  }
  const pattern = managedBlockPattern()
  if (pattern.test(profile)) {
    pattern.lastIndex = 0
    // Why a function: a string replacement treats `$&` and `$$` in the path as patterns.
    return profile.replace(pattern, () => `${block}\n`)
  }
  if (profile.trim().length === 0) {
    return `${block}\n`
  }
  const separator = profile.endsWith('\n') ? '\n' : '\n\n'
  return `${profile}${separator}${block}\n`
}

export async function installWindowsPowerShellCliShim(input: {
  launcherPath: string
  documentsPath: string
  shimPath: string
}): Promise<WindowsPowerShellCliShimStatus> {
  const profilePath = windowsPowerShell51ProfilePath(input.documentsPath)
  const existing = await readProfileFile(profilePath)
  if (existing === 'undecodable') {
    return 'skipped-undecodable-profile'
  }
  const next = upsertManagedProfileBlock(existing?.text ?? '', renderOrcaPowerShellProfileBlock(input.shimPath))
  if (next === 'skipped-user-function') {
    return 'skipped-user-function'
  }
  const unsafePath = [input.launcherPath, input.shimPath].find((value) => /[\r\n\0]/.test(value))
  if (unsafePath) {
    throw new Error('Refusing to write a PowerShell shim for a path that contains a newline')
  }
  await mkdir(dirname(input.shimPath), { recursive: true })
  // Why BOM: Windows PowerShell 5.1 reads a no-BOM .ps1 as the ANSI code page.
  await writeFile(input.shimPath, encodeProfile(renderOrcaPowerShellCliShim(input.launcherPath), 'utf8-bom'))
  // Why BOM: Windows PowerShell 5.1 reads a no-BOM profile as the ANSI code page,
  // so a non-ASCII shim path in that file never loads. UTF-16 already has a BOM.
  const profileEncoding: ProfileEncoding = existing?.encoding === 'utf16le' ? 'utf16le' : 'utf8-bom'
  if (existing?.text === next && existing.encoding === profileEncoding) {
    return 'installed'
  }
  await mkdir(dirname(profilePath), { recursive: true })
  await writeFile(profilePath, encodeProfile(next, profileEncoding))
  return 'installed'
}

export async function removeWindowsPowerShellCliShim(input: {
  documentsPath: string
  shimPath: string
}): Promise<void> {
  await unlinkIfExists(input.shimPath)
  const profilePath = windowsPowerShell51ProfilePath(input.documentsPath)
  const existing = await readProfileFile(profilePath)
  if (!existing || existing === 'undecodable') {
    return
  }
  const next = removeManagedProfileBlock(existing.text)
  if (next.trim().length === 0) {
    await unlinkIfExists(profilePath)
    return
  }
  if (next === existing.text) {
    return
  }
  await writeFile(profilePath, encodeProfile(next.endsWith('\n') ? next : `${next}\n`, existing.encoding))
}

/**
 * Why base64: the folder name can be non-ASCII, and this process's stdout
 * encoding would otherwise replace those characters before Node reads them.
 */
export async function resolveWindowsMyDocumentsPath(): Promise<string> {
  const command =
    "[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([Environment]::GetFolderPath('MyDocuments')))"
  const result = await runProcess({
    program: windowsPowerShellPath(),
    args: ['-NoProfile', '-NonInteractive', '-Command', command],
    timeoutMs: 20_000
  })
  if (result.timedOut || result.code !== 0) {
    throw new Error(result.stderr.trim() || 'Failed to resolve the Windows MyDocuments folder')
  }
  const path = Buffer.from(result.stdout.trim(), 'base64').toString('utf8').trim()
  if (!path) {
    throw new Error('Windows MyDocuments folder is empty')
  }
  return path
}

function powershellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function readProfileFile(
  profilePath: string
): Promise<{ text: string; encoding: ProfileEncoding } | 'undecodable' | null> {
  let bytes: Buffer
  try {
    bytes = await readFile(profilePath)
  } catch (error) {
    if (isMissingFile(error)) {
      return null
    }
    throw error
  }
  return decodeProfile(bytes)
}

function decodeProfile(bytes: Buffer): { text: string; encoding: ProfileEncoding } | 'undecodable' {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: bytes.subarray(2).toString('utf16le'), encoding: 'utf16le' }
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: bytes.subarray(3).toString('utf8'), encoding: 'utf8-bom' }
  }
  const text = bytes.toString('utf8')
  if (Buffer.compare(Buffer.from(text, 'utf8'), bytes) !== 0) {
    return 'undecodable'
  }
  return { text, encoding: 'utf8' }
}

function encodeProfile(text: string, encoding: ProfileEncoding): Buffer {
  if (encoding === 'utf16le') {
    return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
  }
  const body = Buffer.from(text, 'utf8')
  if (encoding === 'utf8') {
    return body
  }
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body])
}

async function unlinkIfExists(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error
    }
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  )
}
