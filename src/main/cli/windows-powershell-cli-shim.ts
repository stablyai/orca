import { execFile } from 'node:child_process'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { CliInstallerOptions } from './cli-installer-contracts'

export const ORCA_POWERSHELL_SHIM_BEGIN = '# >>> orca cli utf-8 shim >>>'
export const ORCA_POWERSHELL_SHIM_END = '# <<< orca cli utf-8 shim <<<'

const USER_ORCA_FUNCTION = /function\s+(?:global:)?orca\b/i

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
    '    $fallback = Get-Command -Name orca.exe -CommandType Application -ErrorAction SilentlyContinue',
    '    if ($fallback) {',
    '      $launcher = $fallback.Source',
    '    } else {',
    '      [Console]::Error.WriteLine("Orca CLI launcher is missing at $launcher")',
    '      $global:LASTEXITCODE = 1',
    '      return',
    '    }',
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

export function removeManagedProfileBlock(profile: string): string {
  const pattern = new RegExp(
    `${escapeRegExp(ORCA_POWERSHELL_SHIM_BEGIN)}[\\s\\S]*?${escapeRegExp(ORCA_POWERSHELL_SHIM_END)}\\r?\\n?`,
    'g'
  )
  return profile.replace(pattern, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n')
}

export function upsertManagedProfileBlock(profile: string, block: string): string | 'skipped-user-function' {
  if (profileHasUserOrcaFunction(profile)) {
    return 'skipped-user-function'
  }
  const without = removeManagedProfileBlock(profile).trim()
  return without.length === 0 ? `${block}\n` : `${without}\n\n${block}\n`
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
  await mkdir(dirname(profilePath), { recursive: true })
  await writeFile(profilePath, encodeProfile(next, existing?.encoding ?? 'utf8-bom'))
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
  const next = removeManagedProfileBlock(existing.text).trim()
  if (next.length === 0) {
    await unlinkIfExists(profilePath)
    return
  }
  if (next === existing.text.trim()) {
    return
  }
  await writeFile(profilePath, encodeProfile(`${next}\n`, existing.encoding))
}

/**
 * Why base64: the folder name can be non-ASCII, and this process's stdout
 * encoding would otherwise replace those characters before Node reads them.
 */
export function resolveWindowsMyDocumentsPath(): Promise<string> {
  const powershell = join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )
  const command =
    "[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([Environment]::GetFolderPath('MyDocuments')))"
  return new Promise((resolve, reject) => {
    execFile(
      powershell,
      ['-NoProfile', '-NonInteractive', '-Command', command],
      { windowsHide: true, timeout: 20_000, encoding: 'utf8' },
      (error, stdout) => {
        if (error) {
          reject(error)
          return
        }
        const path = Buffer.from(stdout.trim(), 'base64').toString('utf8').trim()
        if (!path) {
          reject(new Error('Windows MyDocuments folder is empty'))
          return
        }
        resolve(path)
      }
    )
  })
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
    (error as { code?: string }).code === 'ENOENT'
  )
}
