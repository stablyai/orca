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
      `find ${parentArg} -mindepth 1 -maxdepth 1 -type d -name ${shellEscape(pattern)} -mmin +${Math.ceil(staleSeconds / 60)} -print |`,
      `while IFS= read -r d; do case "$d" in *.upload-????????-????-????-????-????????????) printf '%s\\n' "$d"; count=$((\${count:-0} + 1)); [ "$count" -ge ${limit} ] && break ;; *) continue ;; esac; done;`,
      'fi'
    ].join(' ')
  }
  return powerShellCommand(
    [
      `$parent = ${powerShellLiteral(parent)}`,
      `$pattern = ${powerShellLiteral(pattern)}`,
      `$cutoff = [DateTime]::UtcNow.AddSeconds(-${Math.max(1, Math.ceil(staleSeconds))})`,
      'if (Test-Path -LiteralPath $parent -PathType Container) {',
      'Get-ChildItem -LiteralPath $parent -Directory -Filter $pattern | Where-Object {',
      "$_.LastWriteTimeUtc -lt $cutoff -and $_.Name -match '\\.upload-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'",
      `} | Select-Object -First ${limit} | ForEach-Object { $_.FullName }`,
      '}'
    ].join(' ')
  )
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
      `if find "$d" -prune -type d -mmin +${Math.ceil(staleSeconds / 60)} -print 2>/dev/null | grep -q .; then`,
      'rm -rf "$d";',
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
      '$item = Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue',
      'if (($null -ne $item) -and $item.PSIsContainer -and $item.LastWriteTimeUtc -lt $cutoff) {',
      'Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue',
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
