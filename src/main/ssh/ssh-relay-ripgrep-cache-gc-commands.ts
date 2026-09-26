import { shellEscape } from './ssh-connection-utils'
import {
  REMOTE_RIPGREP_CACHE_DIR_NAME,
  REMOTE_RIPGREP_REF_PREFIX
} from './ssh-relay-ripgrep-install'
import { RELAY_REMOTE_DIR } from './relay-protocol'
import { powerShellCommand, powerShellLiteral } from './ssh-remote-powershell'
import { isWindowsRemoteHost, joinRemotePath, type RemoteHostPlatform } from './ssh-remote-platform'

export const LIST_OK = '__ORCA_RG_CACHE__LIST_OK'
export const REFS_OK = '__ORCA_RG_CACHE__REFS_OK'
export const REFS_ERR = '__ORCA_RG_CACHE__REFS_ERR'
export const TOMBSTONE_PREFIX = '.rg-gc-'
export const MAX_LISTING_ENTRIES = 64

export function cacheDir(host: RemoteHostPlatform, remoteHome: string): string {
  return joinRemotePath(host, remoteHome, RELAY_REMOTE_DIR, REMOTE_RIPGREP_CACHE_DIR_NAME)
}

export function listEntriesCommand(host: RemoteHostPlatform, remoteHome: string): string {
  if (isWindowsRemoteHost(host)) {
    const dir = powerShellLiteral(cacheDir(host, remoteHome))
    return powerShellCommand(
      [
        "$ErrorActionPreference = 'Stop'",
        `if (-not (Test-Path -LiteralPath ${dir})) { '${LIST_OK}'; exit 0 }`,

        // Why the ENTRY prefix and not bare names: PowerShell writes every uncaptured value to
        // stdout, so the token is what separates this listing from anything else a cmdlet emits.
        `Get-ChildItem -LiteralPath ${dir} -Directory -Force -ErrorAction Stop | ForEach-Object { 'ENTRY ' + $_.Name }`,
        `'${LIST_OK}'`
      ].join('\n')
    )
  }
  const dir = shellEscape(cacheDir(host, remoteHome))
  return [
    `d=${dir}`,
    `[ -d "$d" ] || { printf '%s\\n' ${LIST_OK}; exit 0; }`,
    `for e in "$d"/* "$d"/${TOMBSTONE_PREFIX}*; do`,
    '  [ -d "$e" ] || continue',
    `  printf 'ENTRY %s\\n' "$(basename "$e")"`,
    'done',
    `printf '%s\\n' ${LIST_OK}`
  ].join('\n')
}

/**
 * Every relay directory's recorded ripgrep entry.
 *
 * A relay directory with no readable marker answers `REFS_ERR`: it may be an older Orca's relay,
 * running right now against a binary it never recorded.
 */
export function listReferencesCommand(host: RemoteHostPlatform, remoteHome: string): string {
  if (isWindowsRemoteHost(host)) {
    const root = powerShellLiteral(joinRemotePath(host, remoteHome, RELAY_REMOTE_DIR))
    return powerShellCommand(
      [
        "$ErrorActionPreference = 'Stop'",
        `if (-not (Test-Path -LiteralPath ${root})) { '${REFS_OK}'; exit 0 }`,
        `$dirs = @(Get-ChildItem -LiteralPath ${root} -Directory -Force -Filter 'relay-*' -ErrorAction Stop)`,
        `if ($dirs.Count -ge ${MAX_LISTING_ENTRIES}) { '${REFS_ERR}'; exit 0 }`,
        'foreach ($d in $dirs) {',
        // Why PSIsContainer and not `-File`: the remote-payload invariant test greps for that switch,
        // because `powershell.exe -File` is execution-policy gated on the host. This is
        // Get-ChildItem's unrelated filter, but the guard is worth more than the shorter spelling.
        `  $refs = @(Get-ChildItem -LiteralPath $d.FullName -Force -Filter '${REMOTE_RIPGREP_REF_PREFIX}*' -ErrorAction Stop | Where-Object { -not $_.PSIsContainer })`,
        `$legacy = Join-Path $d.FullName '.ripgrep-ref'`,
        `if (Test-Path -LiteralPath $legacy -PathType Leaf) { 'REF ' + (Get-Content -LiteralPath $legacy -Raw -ErrorAction Stop).Trim() } elseif ($refs.Count -eq 0) { '${REFS_ERR}'; exit 0 }`,
        `  foreach ($r in $refs) { 'REF ' + $r.Name.Substring(${REMOTE_RIPGREP_REF_PREFIX.length}) }`,
        '}',
        `'${REFS_OK}'`
      ].join('\n')
    )
  }
  const root = shellEscape(joinRemotePath(host, remoteHome, RELAY_REMOTE_DIR))
  return [
    `root=${root}`,
    `[ -d "$root" ] || { printf '%s\\n' ${REFS_OK}; exit 0; }`,
    `[ -r "$root" ] && [ -x "$root" ] && ls -A "$root" >/dev/null 2>&1 || { printf '%s\\n' ${REFS_ERR}; exit 0; }`,
    'n=0',
    'for d in "$root"/relay-*; do',
    '  [ -d "$d" ] || continue',
    `  [ -r "$d" ] && [ -x "$d" ] || { printf '%s\\n' ${REFS_ERR}; exit 0; }`,
    '  found=0',
    `  if [ -e "$d/.ripgrep-ref" ]; then t=$(cat "$d/.ripgrep-ref") || { printf '%s\\n' ${REFS_ERR}; exit 0; }; printf 'REF %s\\n' "$t"; found=1; fi`,
    `  for f in "$d"/${REMOTE_RIPGREP_REF_PREFIX}*; do`,
    '    [ -f "$f" ] || continue',
    '    found=1',
    // Why the filename and not the contents: the name is what this client minted, and reading it
    // costs nothing extra. The entry is re-validated against ENTRY_NAME before any deletion.
    `    printf 'REF %s\\n' "\${f##*/${REMOTE_RIPGREP_REF_PREFIX}}"`,
    '  done',
    `  [ "$found" = 1 ] || { printf '%s\\n' ${REFS_ERR}; exit 0; }`,
    '  n=$((n+1))',
    `  if [ "$n" -ge ${MAX_LISTING_ENTRIES} ]; then printf '%s\\n' ${REFS_ERR}; exit 0; fi`,
    'done',
    `printf '%s\\n' ${REFS_OK}`
  ].join('\n')
}

// A concurrent installer may already have recreated the original directory.
export function restoreEntryCommand(
  host: RemoteHostPlatform,
  source: string,
  destination: string
): string {
  if (isWindowsRemoteHost(host)) {
    return powerShellCommand(
      `if (-not (Test-Path -LiteralPath ${powerShellLiteral(destination)})) { Move-Item -LiteralPath ${powerShellLiteral(source)} -Destination ${powerShellLiteral(destination)} -ErrorAction Stop; 'MOVED' } else { 'BUSY' }`
    )
  }
  return `if [ ! -e ${shellEscape(destination)} ]; then mv ${shellEscape(source)} ${shellEscape(destination)} && echo MOVED; else echo BUSY; fi`
}
