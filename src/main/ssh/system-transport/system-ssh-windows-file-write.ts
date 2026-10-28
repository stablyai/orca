import { randomBytes } from 'node:crypto'
import { powerShellCommand } from '../ssh-remote-powershell'
import { quotePowerShellLiteral as powerShellLiteral } from '../../../shared/powershell-native-argument'
import { normalizeWindowsRemotePath } from '../ssh-remote-platform'

/** Unique staging names avoid locks from prior writers: contact loss never proves their death (docs/reference/ssh-execution-boundary.md). */
export const WINDOWS_STAGED_WRITE_SUFFIX = '.orca-partial'

export function makeWindowsStagingPath(remotePath: string): string {
  return `${remotePath}${WINDOWS_STAGED_WRITE_SUFFIX}-${randomBytes(6).toString('hex')}`
}

export type WindowsPublishMode = 'create' | 'exclusive' | 'append'

/** Read staging files rather than stdin. Replace atomically without deleting destination; if absent, Move refuses a racing creator and preserves both files. Exclusive mode also relies on Move refusing overwrite. */
export function makeWindowsPublishStagedFileCommand(
  stagingPath: string,
  remotePath: string,
  mode: WindowsPublishMode
): string {
  const preamble = [
    '$ErrorActionPreference = "Stop"',
    `$staging = ${powerShellLiteral(stagingPath)}`,
    `$path = ${powerShellLiteral(remotePath)}`,
    '$parent = [System.IO.Path]::GetDirectoryName($path)',
    'if ($parent) { $null = [System.IO.Directory]::CreateDirectory($parent) }'
  ]
  if (mode === 'append') {
    return powerShellCommand(
      [
        ...preamble,
        // Append is not atomic: partial failure extends the destination; the chunk protocol resumes from its offset.
        '$in = [System.IO.File]::OpenRead($staging)',
        '$out = [System.IO.File]::Open($path, [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)',
        'try { $in.CopyTo($out) } finally { $out.Dispose(); $in.Dispose() }',
        '[System.IO.File]::Delete($staging)'
      ].join('; ')
    )
  }
  if (mode === 'exclusive') {
    return powerShellCommand([...preamble, '[System.IO.File]::Move($staging, $path)'].join('; '))
  }
  return powerShellCommand(
    [
      ...preamble,
      // PowerShell binds $null to empty string, which File.Replace rejects; NullString.Value supplies a null backup path (measured on 5.1).
      'try { [System.IO.File]::Replace($staging, $path, [NullString]::Value) } catch [System.IO.FileNotFoundException] { [System.IO.File]::Move($staging, $path) }'
    ].join('; ')
  )
}

/** Best-effort removal of a staged file whose write was abandoned. Never asserts the writer died. */
export function makeWindowsDiscardStagedFileCommand(stagingPath: string): string {
  return powerShellCommand(
    [
      // A prior writer may retain the file lock; unique names make failed cleanup harmless.
      '$ErrorActionPreference = "SilentlyContinue"',
      `$staging = ${powerShellLiteral(stagingPath)}`,
      '[System.IO.File]::Delete($staging)'
    ].join('; ')
  )
}

/** SFTP mkdir creates one level at a time; return ancestors in order, excluding drive/UNC root. */
export function windowsRemoteAncestorDirectories(remotePath: string): string[] {
  const normalized = normalizeWindowsRemotePath(remotePath)
  const segments = normalized.split('/')
  segments.pop()
  const ancestors: string[] = []
  // Start past the drive (`C:`) or the UNC host, which are never created.
  for (let depth = 2; depth <= segments.length; depth += 1) {
    const directory = segments.slice(0, depth).join('/')
    if (directory) {
      ancestors.push(directory)
    }
  }
  return ancestors
}

/** Stdin fallback only: defective under PowerShell 5.1, reliable under 7 (see system-ssh-file-binary-transfer.ts). */
export function makeWindowsWriteFileCommand(
  remotePath: string,
  options?: { append?: boolean; exclusive?: boolean; executable?: 'powershell.exe' | 'pwsh.exe' }
): string {
  const fileMode = options?.append ? 'Append' : options?.exclusive ? 'CreateNew' : 'Create'
  return powerShellCommand(
    [
      '$ErrorActionPreference = "Stop"',
      `$path = ${powerShellLiteral(remotePath)}`,
      '$parent = [System.IO.Path]::GetDirectoryName($path)',
      'if ($parent) { $null = [System.IO.Directory]::CreateDirectory($parent) }',
      '$inputStream = [Console]::OpenStandardInput()',
      `$outputStream = [System.IO.File]::Open($path, [System.IO.FileMode]::${fileMode}, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)`,
      'try { $inputStream.CopyTo($outputStream) } finally { $outputStream.Dispose() }'
    ].join('; '),
    options?.executable ?? 'powershell.exe'
  )
}
