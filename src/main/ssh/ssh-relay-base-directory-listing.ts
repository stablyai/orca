import type { RemoteHostPlatform } from './ssh-remote-platform'
import { isWindowsRemoteHost } from './ssh-remote-platform'
import { powerShellCommand, powerShellLiteral } from './ssh-remote-powershell'
import { shellEscape } from './ssh-connection-utils'

export const RELAY_BASE_DIRECTORY_MAX_ENTRIES = 4_096
export const RELAY_BASE_DIRECTORY_MAX_UTF8_BYTES = 256 * 1024
export const RELAY_BASE_DIRECTORY_LISTING_LIMIT_SENTINEL =
  '__ORCA_RELAY_BASE_DIRECTORY_LISTING_TOO_LARGE__'

export function isRelayBaseDirectoryListingLimited(listing: string): boolean {
  return listing
    .split(/\r?\n/)
    .some((line) => line.trim() === RELAY_BASE_DIRECTORY_LISTING_LIMIT_SENTINEL)
}

type RelayBaseDirectoryListingOptions = {
  maxEntries?: number
  maxUtf8Bytes?: number
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new Error(`${name} must be a positive integer`)
  }
  return resolved
}

export function getRelayBaseDirectoryListingCommand(
  host: RemoteHostPlatform,
  baseDir: string,
  options?: RelayBaseDirectoryListingOptions
): string {
  const maxEntries = positiveInteger(
    options?.maxEntries,
    RELAY_BASE_DIRECTORY_MAX_ENTRIES,
    'maxEntries'
  )
  const maxUtf8Bytes = positiveInteger(
    options?.maxUtf8Bytes,
    RELAY_BASE_DIRECTORY_MAX_UTF8_BYTES,
    'maxUtf8Bytes'
  )

  if (!isWindowsRemoteHost(host)) {
    const awkProgram = [
      '{',
      'entry_count++;',
      `if(entry_count>${maxEntries}){print "${RELAY_BASE_DIRECTORY_LISTING_LIMIT_SENTINEL}";exit}`,
      'name=$0;sub(/^.*\\//,"",name);',
      'if(substr(name,1,1)==".")next;',
      'line_bytes=length(name)+1;',
      `if(output_bytes+line_bytes>${maxUtf8Bytes}){print "${RELAY_BASE_DIRECTORY_LISTING_LIMIT_SENTINEL}";exit}`,
      'print name;output_bytes+=line_bytes',
      '}'
    ].join('')
    return [
      `base=${shellEscape(baseDir)};`,
      'if [ -d "$base" ]; then',
      'LC_ALL=C find "$base" -mindepth 1 -maxdepth 1 -print 2>/dev/null',
      `| LC_ALL=C awk ${shellEscape(awkProgram)} | sort;`,
      'fi'
    ].join(' ')
  }

  return powerShellCommand(
    [
      `$base = ${powerShellLiteral(baseDir)}`,
      `if (Test-Path -LiteralPath $base -PathType Container) {`,
      `$maxEntries = ${maxEntries}`,
      `$maxBytes = ${maxUtf8Bytes}`,
      `$sentinel = ${powerShellLiteral(RELAY_BASE_DIRECTORY_LISTING_LIMIT_SENTINEL)}`,
      '$entryCount = 0',
      '$outputBytes = 0',
      '$iterator = ([System.IO.Directory]::EnumerateDirectories($base)).GetEnumerator()',
      'try {',
      'while ($iterator.MoveNext()) {',
      'if ($entryCount -ge $maxEntries) { Write-Output $sentinel; break }',
      '$entryCount++',
      '$name = [System.IO.Path]::GetFileName([string]$iterator.Current)',
      '$lineBytes = [System.Text.Encoding]::UTF8.GetByteCount($name) + 2',
      'if (($outputBytes + $lineBytes) -gt $maxBytes) { Write-Output $sentinel; break }',
      'Write-Output $name',
      '$outputBytes += $lineBytes',
      '}',
      '} finally {',
      'if ($null -ne $iterator) { $iterator.Dispose() }',
      '}',
      '}'
    ].join('\n')
  )
}
