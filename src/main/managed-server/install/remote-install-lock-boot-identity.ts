import { quotePosixShell } from '../../../shared/shell/launch/shell-argument-quoting'
import type { RemoteHostPlatform } from '../../ssh/remote-host/ssh-remote-platform'

/** Install lock boot marker: a lock from a previous boot is reclaimable at once. */
const INSTALL_LOCK_BOOT_ID_NAME = '.boot-id'

export function posixCurrentBootIdentityAssignment(
  host: RemoteHostPlatform,
  variableName: string
): string {
  if (host.os === 'darwin') {
    return `${variableName}=$(sysctl -n kern.boottime 2>/dev/null | sed -n 's/^.*{ sec = \\([0-9][0-9]*\\),.*$/darwin:\\1/p');`
  }
  return [
    `${variableName}=;`,
    'kernel_boot_id=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null) || kernel_boot_id=;',
    `pid1_start_ticks=$(sed 's/^.*) //' /proc/1/stat 2>/dev/null | awk '{ print $20 }') || pid1_start_ticks=;`,
    `if [ -n "$kernel_boot_id" ] && [ -n "$pid1_start_ticks" ]; then ${variableName}="linux:$kernel_boot_id:$pid1_start_ticks"; fi;`
  ].join(' ')
}

export function posixReadBootIdentity(lockDir: string, variableName: string): string {
  const markerPath = quotePosixShell(`${lockDir}/${INSTALL_LOCK_BOOT_ID_NAME}`)
  return [
    `${variableName}=$(head -c 128 ${markerPath} 2>/dev/null | tr -d '\\r\\n') || ${variableName}=;`,
    `if ! printf '%s\\n' "$${variableName}" | grep -Eq '^(linux:[0-9a-fA-F-]{1,64}:[0-9]{1,32}|darwin:[0-9]{1,32})$'; then ${variableName}=; fi;`
  ].join(' ')
}

export function posixWriteBootIdentity(lockDir: string, variableName: string): string {
  const markerPath = quotePosixShell(`${lockDir}/${INSTALL_LOCK_BOOT_ID_NAME}`)
  const markerTempPrefix = quotePosixShell(`${lockDir}/${INSTALL_LOCK_BOOT_ID_NAME}.tmp`)
  return [
    `if [ -n "$${variableName}" ]; then`,
    `boot_marker_tmp=${markerTempPrefix}.$$;`,
    `if printf '%s\\n' "$${variableName}" > "$boot_marker_tmp" 2>/dev/null; then mv "$boot_marker_tmp" ${markerPath} 2>/dev/null || rm -f "$boot_marker_tmp"; else rm -f "$boot_marker_tmp"; fi;`,
    'fi;'
  ].join(' ')
}

export function windowsCurrentBootIdentityStatements(variableName: string): string[] {
  return [
    `${variableName} = $null`,
    'try {',
    '$operatingSystem = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop',
    '$bootTicks = ([DateTime]$operatingSystem.LastBootUpTime).ToUniversalTime().Ticks',
    `${variableName} = "win32:$bootTicks"`,
    '} catch {}'
  ]
}

export function windowsReadBootIdentityStatements(
  lockVariable: string,
  valueVariable: string
): string[] {
  return [
    `${valueVariable} = $null`,
    'try {',
    `$bootMarker = Join-Path ${lockVariable} '${INSTALL_LOCK_BOOT_ID_NAME}'`,
    '$bootMarkerItem = Get-Item -LiteralPath $bootMarker -ErrorAction Stop',
    `if ($bootMarkerItem.Length -le 128) { ${valueVariable} = [System.IO.File]::ReadAllText($bootMarker).Trim() }`,
    `if (${valueVariable} -notmatch '^win32:[0-9]{1,32}$') { ${valueVariable} = $null }`,
    '} catch {}'
  ]
}

export function windowsWriteBootIdentityStatement(
  lockVariable: string,
  valueVariable: string
): string {
  return [
    `if (-not [string]::IsNullOrWhiteSpace(${valueVariable})) {`,
    `$bootMarkerPath = Join-Path ${lockVariable} '${INSTALL_LOCK_BOOT_ID_NAME}'`,
    '$bootMarkerTemp = "$bootMarkerPath.tmp.$PID.$([Guid]::NewGuid().ToString(\'N\'))"',
    'try { [System.IO.File]::WriteAllText($bootMarkerTemp, ' +
      `${valueVariable}); [System.IO.File]::Move($bootMarkerTemp, $bootMarkerPath) } catch {} finally { Remove-Item -LiteralPath $bootMarkerTemp -Force -ErrorAction SilentlyContinue }`,
    '}'
  ].join('; ')
}
