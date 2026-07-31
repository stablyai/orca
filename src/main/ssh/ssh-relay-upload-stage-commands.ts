import { shellEscape } from './ssh-connection-utils'
import {
  isWindowsRemoteHost,
  normalizeWindowsRemotePath,
  remoteBasename,
  remoteDirname,
  type RemoteHostPlatform
} from './ssh-remote-platform'
import { powerShellCommand, powerShellLiteral } from './ssh-remote-powershell'

export const MAX_STALE_UPLOAD_STAGE_CANDIDATES = 8
export const STALE_UPLOAD_STAGE_OUTPUT_PREFIX = '__ORCA_STALE_UPLOAD_STAGE__'
const STALE_UPLOAD_STAGE_FIND_STATUS_PREFIX = '__ORCA_STALE_UPLOAD_STAGE_FIND_STATUS__'

export function listStaleRemoteUploadStagesCommand(
  host: RemoteHostPlatform,
  remoteRelayDir: string,
  staleSeconds: number,
  maxCandidates: number
): string {
  const requestedLimit = Number.isSafeInteger(maxCandidates) ? maxCandidates : 1
  const limit = Math.min(MAX_STALE_UPLOAD_STAGE_CANDIDATES, Math.max(1, requestedLimit))
  const parent = remoteDirname(remoteRelayDir, host)
  const base = remoteBasename(remoteRelayDir, host)
  const pattern = `${base}.upload-*`
  if (!isWindowsRemoteHost(host)) {
    const parentArg = shellEscape(parent)
    return [
      `if [ -d ${parentArg} ]; then`,
      `{ find ${parentArg} -mindepth 1 -maxdepth 1 -type d -name ${shellEscape(pattern)} -mmin +${Math.ceil(staleSeconds / 60)} -print; status=$?; printf '${STALE_UPLOAD_STAGE_FIND_STATUS_PREFIX}%s\\n' "$status"; } |`,
      `{ while IFS= read -r d; do case "$d" in ${STALE_UPLOAD_STAGE_FIND_STATUS_PREFIX}0) printf '%s' "$stages"; exit 0 ;; ${STALE_UPLOAD_STAGE_FIND_STATUS_PREFIX}*) exit 1 ;; *.upload-????????-????-????-????-????????????) count=$((\${count:-0} + 1)); if [ "$count" -le ${limit} ]; then stages="\${stages:-}${STALE_UPLOAD_STAGE_OUTPUT_PREFIX}$d
"; fi ;; *) continue ;; esac; done;`,
      'exit 1; };',
      'list_status=$?; [ "$list_status" -eq 0 ] || exit "$list_status";',
      'fi;',
      'exit 0'
    ].join(' ')
  }
  return powerShellCommand(
    [
      "$ErrorActionPreference = 'Stop'",
      `$parent = ${powerShellLiteral(parent)}`,
      `$pattern = ${powerShellLiteral(pattern)}`,
      `$cutoff = [DateTime]::UtcNow.AddSeconds(-${Math.max(1, Math.ceil(staleSeconds))})`,
      'if (Test-Path -LiteralPath $parent -PathType Container) {',
      'Get-ChildItem -LiteralPath $parent -Directory -Filter $pattern | Where-Object {',
      "$_.LastWriteTimeUtc -lt $cutoff -and $_.Name -match '\\.upload-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'",
      `} | Select-Object -First ${limit} | ForEach-Object { '${STALE_UPLOAD_STAGE_OUTPUT_PREFIX}' + $_.FullName }`,
      '}'
    ].join(' ')
  )
}

export function parseStaleRemoteUploadStageListing(
  host: RemoteHostPlatform,
  remoteRelayDir: string,
  listing: string
): string[] {
  return [
    ...new Set(
      listing
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith(STALE_UPLOAD_STAGE_OUTPUT_PREFIX))
        .map((line) => line.slice(STALE_UPLOAD_STAGE_OUTPUT_PREFIX.length))
        .filter((stage) => isRemoteUploadStagePath(host, remoteRelayDir, stage))
    )
  ].slice(0, MAX_STALE_UPLOAD_STAGE_CANDIDATES)
}

export function removeStaleRemoteUploadStagesCommand(
  host: RemoteHostPlatform,
  remoteRelayDir: string,
  candidatePaths: string[],
  staleSeconds: number
): string {
  if (
    candidatePaths.length === 0 ||
    candidatePaths.length > MAX_STALE_UPLOAD_STAGE_CANDIDATES ||
    candidatePaths.some((candidate) => !isRemoteUploadStagePath(host, remoteRelayDir, candidate))
  ) {
    throw new Error('Invalid stale relay upload stage cleanup request')
  }
  if (!isWindowsRemoteHost(host)) {
    const candidates = candidatePaths.map(shellEscape).join(' ')
    return [
      `for d in ${candidates}; do`,
      '[ -d "$d" ] || continue;',
      'tombstone="${d}.cleanup-$$";',
      '[ ! -e "$tombstone" ] || continue;',
      `if find "$d" -prune -type d -mmin +${Math.ceil(staleSeconds / 60)} -print 2>/dev/null | grep -q .; then`,
      'if mv "$d" "$tombstone"; then',
      `if find "$tombstone" -prune -type d -mmin +${Math.ceil(staleSeconds / 60)} -print 2>/dev/null | grep -q .; then`,
      'rm -rf "$tombstone";',
      '[ ! -e "$tombstone" ] || [ -e "$d" ] || mv "$tombstone" "$d" || :;',
      'elif [ ! -e "$d" ]; then mv "$tombstone" "$d" || :; fi;',
      'fi;',
      'fi;',
      'done'
    ].join(' ')
  }
  const candidates = candidatePaths.map(powerShellLiteral).join(', ')
  return powerShellCommand(
    [
      `$cutoff = [DateTime]::UtcNow.AddSeconds(-${Math.max(1, Math.ceil(staleSeconds))})`,
      `@(${candidates}) | ForEach-Object {`,
      '$path = $_',
      '$tombstone = "$path.cleanup-$PID"',
      '$item = Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue',
      'if (($null -ne $item) -and $item.PSIsContainer -and $item.LastWriteTimeUtc -lt $cutoff -and -not (Test-Path -LiteralPath $tombstone)) {',
      'Move-Item -LiteralPath $path -Destination $tombstone -ErrorAction SilentlyContinue',
      '$claimed = Get-Item -LiteralPath $tombstone -Force -ErrorAction SilentlyContinue',
      'if (($null -ne $claimed) -and $claimed.PSIsContainer -and $claimed.LastWriteTimeUtc -lt $cutoff) {',
      'Remove-Item -LiteralPath $tombstone -Recurse -Force -ErrorAction SilentlyContinue',
      'if ((Test-Path -LiteralPath $tombstone) -and -not (Test-Path -LiteralPath $path)) {',
      'Move-Item -LiteralPath $tombstone -Destination $path -ErrorAction SilentlyContinue',
      '}',
      '} elseif (($null -ne $claimed) -and -not (Test-Path -LiteralPath $path)) {',
      'Move-Item -LiteralPath $tombstone -Destination $path -ErrorAction SilentlyContinue',
      '}',
      '}',
      '}'
    ].join('; ')
  )
}

export function isRemoteUploadStagePath(
  host: RemoteHostPlatform,
  remoteRelayDir: string,
  candidatePath: string
): boolean {
  if (
    !candidatePath ||
    candidatePath.includes('\0') ||
    candidatePath.includes('\r') ||
    candidatePath.includes('\n')
  ) {
    return false
  }
  const candidate = isWindowsRemoteHost(host)
    ? normalizeWindowsRemotePath(candidatePath)
    : candidatePath
  const expectedParent = remoteDirname(remoteRelayDir, host)
  const candidateParent = remoteDirname(candidate, host)
  const expectedPrefix = `${remoteBasename(remoteRelayDir, host)}.upload-`
  const candidateBase = remoteBasename(candidate, host)
  const sameParent = isWindowsRemoteHost(host)
    ? candidateParent.toLowerCase() === expectedParent.toLowerCase()
    : candidateParent === expectedParent
  const comparableBase = isWindowsRemoteHost(host) ? candidateBase.toLowerCase() : candidateBase
  const comparablePrefix = isWindowsRemoteHost(host) ? expectedPrefix.toLowerCase() : expectedPrefix
  return (
    sameParent &&
    comparableBase.startsWith(comparablePrefix) &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
      comparableBase.slice(comparablePrefix.length)
    )
  )
}
