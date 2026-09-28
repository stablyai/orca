import { posix } from 'node:path'
import { shellEscape } from './ssh-connection-utils'
import { powerShellCommand, powerShellLiteral } from './ssh-remote-powershell'
import { isWindowsRemoteHost, type RemoteHostPlatform } from './ssh-remote-platform'

const READY = '__ORCA_BUN_READY__'
const MISSING = '__ORCA_BUN_MISSING__'
const posixHash = `runtime_hash() {
  [ -f "$1" ] && [ ! -L "$1" ] || return 1
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1"
  else echo 'Orca runtime verification needs sha256sum or shasum' >&2; return 2; fi
}`
const posixLookup = `find_runtime() {
  candidate="$1"
  digest=$(runtime_hash "$candidate")
  if [ "\${digest%% *}" = "$2" ]; then printf '%s' "$candidate"; return 0; fi
  reference="\${candidate%/*}/.current-repair"
  [ -f "$reference" ] && [ ! -L "$reference" ] || return 1
  [ "$(wc -c < "$reference")" -le 64 ] || return 1
  repair=$(cat "$reference") || return 1
  token=\${repair#repair-}
  [ "$repair" != "$token" ] && [ "\${#token}" -eq 24 ] || return 1
  case "$token" in *[!0-9a-f]*) return 1;; esac
  repair_directory="\${candidate%/*}/$repair"
  [ -d "$repair_directory" ] && [ ! -L "$repair_directory" ] || return 1
  candidate="$repair_directory/\${candidate##*/}"
  digest=$(runtime_hash "$candidate")
  [ "\${digest%% *}" = "$2" ] || return 1
  printf '%s' "$candidate"
}`
const windowsHash = `function Runtime-Hash([string]$file) {
  if (!(Test-Path -LiteralPath $file -PathType Leaf)) { return '' }
  if ((Get-Item -LiteralPath $file).Attributes -band [IO.FileAttributes]::ReparsePoint) { return '' }
  $stream = [IO.File]::OpenRead($file)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-','').ToLowerInvariant() }
  finally { $stream.Dispose(); $sha.Dispose() }
}`

const windowsLookup = `function Find-Runtime([string]$file, [string]$expected) {
  if ((Runtime-Hash $file) -eq $expected) { return $file }
  $reference = Join-Path ([IO.Path]::GetDirectoryName($file)) '.current-repair'
  if (!(Test-Path -LiteralPath $reference -PathType Leaf)) { return '' }
  $item = Get-Item -LiteralPath $reference
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -gt 64) { return '' }
  $repair = [IO.File]::ReadAllText($reference).Trim()
  if ($repair -cnotmatch '^repair-[0-9a-f]{24}$') { return '' }
  $directory = Join-Path ([IO.Path]::GetDirectoryName($file)) $repair
  if (!(Test-Path -LiteralPath $directory -PathType Container)) { return '' }
  if ((Get-Item -LiteralPath $directory).Attributes -band [IO.FileAttributes]::ReparsePoint) { return '' }
  $candidate = Join-Path $directory ([IO.Path]::GetFileName($file))
  if ((Runtime-Hash $candidate) -eq $expected) { return $candidate }
  return ''
}`

function checkedHash(hash: string): string {
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error('Invalid bundled runtime checksum')
  }
  return hash
}

/** Verify a cached executable without depending on an installed JavaScript runtime. */
export function probeRelayBunRuntimeCommand(
  host: RemoteHostPlatform,
  executable: string,
  expectedHash: string
): string {
  checkedHash(expectedHash)
  if (isWindowsRemoteHost(host)) {
    return powerShellCommand(`$ErrorActionPreference = 'Stop'; ${windowsHash}
${windowsLookup}
$file = Find-Runtime ${powerShellLiteral(executable)} '${expectedHash}'
if ($file) { Write-Output '${READY}'; Write-Output $file }
else { Write-Output '${MISSING}' }`)
  }
  return `${posixHash}
${posixLookup}
file=$(find_runtime ${shellEscape(executable)} '${expectedHash}')
if [ -n "$file" ]; then
  chmod 700 "$file" && printf '${READY}\\n%s\\n' "$file"
else printf '${MISSING}\\n'; fi`
}

/** Corrupt or busy cache entries stay untouched; repairs occupy a new owned directory. */
export function promoteRelayBunRuntimeCommand(options: {
  host: RemoteHostPlatform
  source: string
  executable: string
  expectedHash: string
  repairToken: string
}): string {
  const { host, source, executable, expectedHash, repairToken } = options
  checkedHash(expectedHash)
  if (!/^[a-f0-9]{24}$/.test(repairToken)) {
    throw new Error('Invalid runtime repair token')
  }
  const directory = posix.dirname(executable.replaceAll('\\', '/'))
  const repairDirectory = `${directory}/repair-${repairToken}`
  const repair = `${repairDirectory}/${posix.basename(executable.replaceAll('\\', '/'))}`
  const reference = `${directory}/.current-repair`
  const temporaryReference = `${repairDirectory}/.current-repair`
  if (isWindowsRemoteHost(host)) {
    return powerShellCommand(`$ErrorActionPreference = 'Stop'; ${windowsHash}
$source = ${powerShellLiteral(source)}; $file = ${powerShellLiteral(executable)}
if ((Runtime-Hash $source) -ne '${expectedHash}') { throw 'Uploaded Bun runtime checksum mismatch' }
if ((Runtime-Hash $file) -ne '${expectedHash}') {
  [IO.Directory]::CreateDirectory(${powerShellLiteral(directory)}) | Out-Null
  try { [IO.File]::Move($source, $file) }
  catch {
    if ((Runtime-Hash $file) -ne '${expectedHash}') {
      $file = ${powerShellLiteral(repair)}
      New-Item -ItemType Directory -Path ${powerShellLiteral(repairDirectory)} -ErrorAction Stop | Out-Null
      [IO.File]::Move($source, $file)
    }
  }
}
if ((Runtime-Hash $file) -ne '${expectedHash}') { throw 'Published Bun runtime checksum mismatch' }
if ($file -eq ${powerShellLiteral(repair)}) {
  [IO.File]::WriteAllText(${powerShellLiteral(temporaryReference)}, 'repair-${repairToken}')
  Move-Item -LiteralPath ${powerShellLiteral(temporaryReference)} -Destination ${powerShellLiteral(reference)} -Force
}
Write-Output '${READY}'; Write-Output $file`)
  }
  return `${posixHash}
source=${shellEscape(source)}; file=${shellEscape(executable)}
digest=$(runtime_hash "$source") || exit 1
[ "\${digest%% *}" = '${expectedHash}' ] || { echo 'Uploaded Bun runtime checksum mismatch' >&2; exit 1; }
digest=$(runtime_hash "$file")
if [ "\${digest%% *}" != '${expectedHash}' ]; then
  mkdir -p ${shellEscape(directory)} || exit 1
  chmod 700 "$source" || exit 1
  if [ -e "$file" ] || [ -L "$file" ] || ! ln -n "$source" "$file" 2>/dev/null; then
    digest=$(runtime_hash "$file")
    if [ "\${digest%% *}" != '${expectedHash}' ]; then
      mkdir ${shellEscape(repairDirectory)} || exit 1
      file=${shellEscape(repair)}
      mv "$source" "$file" || exit 1
    fi
  fi
fi
digest=$(runtime_hash "$file") || exit 1
[ "\${digest%% *}" = '${expectedHash}' ] || exit 1
chmod 700 "$file" || exit 1
if [ "$file" = ${shellEscape(repair)} ]; then
  printf '%s' 'repair-${repairToken}' > ${shellEscape(temporaryReference)} &&
    mv -f ${shellEscape(temporaryReference)} ${shellEscape(reference)} || exit 1
fi
printf '${READY}\\n%s\\n' "$file"`
}

export function parseRelayBunRuntimeResult(output: string): string | undefined {
  const lines = output.split(/\r?\n/)
  const index = lines.lastIndexOf(READY)
  if (index !== -1 && lines[index + 1]) {
    return lines[index + 1]
  }
  if (lines.includes(MISSING)) {
    return undefined
  }
  throw new Error('The host did not confirm its bundled Bun runtime')
}
