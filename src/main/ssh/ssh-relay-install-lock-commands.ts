import { shellEscape } from './ssh-connection-utils'
import { powerShellCommand, powerShellLiteral } from './ssh-remote-powershell'
import { isWindowsRemoteHost, type RemoteHostPlatform } from './ssh-remote-platform'

const INSTALL_LOCK_BOOT_ID_NAME = '.boot-id'

export function acquireInstallLockParentCommand(
  host: RemoteHostPlatform,
  remoteRelayDir: string
): string {
  if (!isWindowsRemoteHost(host)) {
    return `mkdir -p ${shellEscape(remoteRelayDir)}`
  }
  return powerShellCommand(
    `$null = New-Item -ItemType Directory -Force -Path ${powerShellLiteral(remoteRelayDir)}`
  )
}

export function tryCreateInstallLockCommand(host: RemoteHostPlatform, lockDir: string): string {
  if (!isWindowsRemoteHost(host)) {
    return [
      `if mkdir ${shellEscape(lockDir)} 2>/dev/null; then`,
      posixCurrentBootIdentityAssignment(host, 'current_boot_id'),
      posixWriteBootIdentity(lockDir, 'current_boot_id'),
      'echo OK;',
      'else echo BUSY; fi'
    ].join(' ')
  }
  // Why: old Orca clients recognize only a directory at `.install-lock`, while
  // concurrent New-Item calls can both report success in PowerShell 5.1. Keep
  // that directory marker and arbitrate ownership with an atomic child file.
  return powerShellCommand(
    [
      `$lock = ${powerShellLiteral(lockDir)}`,
      '$stream = $null',
      'try {',
      "if (Test-Path -LiteralPath $lock) { 'BUSY' } else {",
      '$null = New-Item -ItemType Directory -Path $lock -ErrorAction Stop',
      "$owner = Join-Path $lock '.owner'",
      '$stream = [System.IO.File]::Open($owner, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)',
      ...windowsCurrentBootIdentityStatements('$currentBootId'),
      windowsWriteBootIdentityStatement('$lock', '$currentBootId'),
      "'OK'",
      '}',
      `} catch { 'BUSY' } finally { if ($null -ne $stream) { $stream.Dispose() } }`
    ].join('; ')
  )
}

export function probeInstallLockExistsCommand(host: RemoteHostPlatform, lockPath: string): string {
  if (!isWindowsRemoteHost(host)) {
    return `test -e ${shellEscape(lockPath)} && echo LOCKED || echo OPEN`
  }
  // Why: one prerelease briefly wrote file locks; accept both shapes so those
  // hosts remain recoverable after upgrading to directory-plus-owner locks.
  return powerShellCommand(
    `if (Test-Path -LiteralPath ${powerShellLiteral(lockPath)}) { 'LOCKED' } else { 'OPEN' }`
  )
}

export function lockAgeSecondsCommand(host: RemoteHostPlatform, lockDir: string): string {
  if (!isWindowsRemoteHost(host)) {
    return `${posixLockAgeSecondsAssignment(lockDir)} && echo "$age" || echo`
  }
  return powerShellCommand(
    [
      `$item = Get-Item -LiteralPath ${powerShellLiteral(lockDir)} -ErrorAction Stop`,
      '$mtime = ([DateTimeOffset]$item.LastWriteTimeUtc).ToUnixTimeSeconds()',
      '$now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()',
      'Write-Output ($now - $mtime)'
    ].join('; ')
  )
}

export function tryStealInstallLockCommand(
  host: RemoteHostPlatform,
  lockDir: string,
  staleAfterSeconds: number
): string {
  if (!isWindowsRemoteHost(host)) {
    return posixStealInstallLockCommand(host, lockDir, staleAfterSeconds)
  }
  return windowsStealInstallLockCommand(lockDir, staleAfterSeconds)
}

function posixStealInstallLockCommand(
  host: RemoteHostPlatform,
  lockDir: string,
  staleAfterSeconds: number
): string {
  const escapedLockDir = shellEscape(lockDir)
  const escapedStealLockPrefix = shellEscape(`${lockDir}.steal`)
  return [
    posixCurrentBootIdentityAssignment(host, 'current_boot_id'),
    `${posixReadBootIdentity(lockDir, 'recorded_boot_id')}`,
    'rebooted=0;',
    'if [ -n "$recorded_boot_id" ] && [ -n "$current_boot_id" ] && [ "$recorded_boot_id" != "$current_boot_id" ]; then rebooted=1; fi;',
    `${posixLockIdentityAssignment(lockDir, 'lock_key')} && mtime=\${lock_key%%:*} && now=$(date +%s) && age=$((now - mtime)) || age=0;`,
    `if [ "\${age:-0}" -le ${staleAfterSeconds} ] 2>/dev/null && [ "$rebooted" != 1 ]; then echo BUSY; else`,
    `steal_root=${escapedStealLockPrefix};`,
    'steal_generation=0;',
    'steal="$steal_root.$steal_generation";',
    'owns_steal=0;',
    'lock_tombstone=;',
    'while [ "$owns_steal" != 1 ]; do',
    'if mkdir "$steal" 2>/dev/null; then owns_steal=1; break; fi;',
    `steal_mtime=$(stat -c %Y "$steal" 2>/dev/null || stat -f %m "$steal" 2>/dev/null) && steal_now=$(date +%s) && steal_age=$((steal_now - steal_mtime)) || break;`,
    'if [ "${steal_age:-0}" -le 120 ] 2>/dev/null; then break; fi;',
    'steal_generation=$((steal_generation + 1));',
    'steal="$steal_root.$steal_generation";',
    'done;',
    'if [ "$owns_steal" = 1 ]; then',
    `trap 'rm -rf "$steal_root".* 2>/dev/null || true; rm -rf "$lock_tombstone" 2>/dev/null || true' EXIT;`,
    `${posixLockIdentityAssignment(lockDir, 'current_key')} && current_mtime=\${current_key%%:*} && current_now=$(date +%s) && current_age=$((current_now - current_mtime)) || current_age=0;`,
    `${posixReadBootIdentity(lockDir, 'current_recorded_boot_id')}`,
    'current_rebooted=0;',
    'if [ -n "$current_recorded_boot_id" ] && [ -n "$current_boot_id" ] && [ "$current_recorded_boot_id" != "$current_boot_id" ]; then current_rebooted=1; fi;',
    `if [ "$current_key" = "$lock_key" ] && { [ "\${current_age:-0}" -gt ${staleAfterSeconds} ] 2>/dev/null || [ "$current_rebooted" = 1 ]; }; then`,
    `lock_tombstone=${escapedLockDir}.tombstone.$$.$(date +%s);`,
    `if [ ! -e "$lock_tombstone" ] && mv ${escapedLockDir} "$lock_tombstone" 2>/dev/null; then`,
    `if mkdir ${escapedLockDir} 2>/dev/null; then`,
    posixWriteBootIdentity(lockDir, 'current_boot_id'),
    'if [ "$current_rebooted" = 1 ]; then echo REBOOT_OK; else echo OK; fi;',
    'else echo BUSY; fi; else echo BUSY; fi;',
    'else echo BUSY; fi;',
    'else echo BUSY; fi; fi'
  ].join(' ')
}

function windowsStealInstallLockCommand(lockDir: string, staleAfterSeconds: number): string {
  return powerShellCommand(
    [
      `$lock = ${powerShellLiteral(lockDir)}`,
      'try {',
      ...windowsCurrentBootIdentityStatements('$currentBootId'),
      ...windowsReadBootIdentityStatements('$lock', '$recordedBootId'),
      '$rebooted = (-not [string]::IsNullOrWhiteSpace($recordedBootId)) -and (-not [string]::IsNullOrWhiteSpace($currentBootId)) -and ($recordedBootId -cne $currentBootId)',
      '$item = Get-Item -LiteralPath $lock -ErrorAction Stop',
      '$mtime = ([DateTimeOffset]$item.LastWriteTimeUtc).ToUnixTimeSeconds()',
      '$lockIdentity = "${mtime}:$($item.CreationTimeUtc.Ticks)"',
      '$now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()',
      `if ((($now - $mtime) -le ${staleAfterSeconds}) -and (-not $rebooted)) { 'BUSY' } else {`,
      '$stealRoot = "$lock.steal"',
      '$stealGeneration = 0',
      '$steal = "$stealRoot.$stealGeneration"',
      '$ownsSteal = $false',
      '$lockTombstone = $null',
      'try {',
      'while (-not $ownsSteal) {',
      'try {',
      '$stealStream = [System.IO.File]::Open($steal, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)',
      '$stealStream.Dispose()',
      '$ownsSteal = $true',
      'break',
      '} catch {',
      'try {',
      '$stealItem = Get-Item -LiteralPath $steal -ErrorAction Stop',
      '$stealMtime = ([DateTimeOffset]$stealItem.LastWriteTimeUtc).ToUnixTimeSeconds()',
      '$stealAge = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() - $stealMtime',
      'if ($stealAge -le 120) { break }',
      '$stealGeneration++',
      '$steal = "$stealRoot.$stealGeneration"',
      '} catch { break }',
      '}',
      '}',
      "if (-not $ownsSteal) { 'BUSY' } else {",
      '$current = Get-Item -LiteralPath $lock -ErrorAction Stop',
      '$currentMtime = ([DateTimeOffset]$current.LastWriteTimeUtc).ToUnixTimeSeconds()',
      '$currentIdentity = "${currentMtime}:$($current.CreationTimeUtc.Ticks)"',
      '$currentNow = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()',
      ...windowsReadBootIdentityStatements('$lock', '$currentRecordedBootId'),
      '$currentRebooted = (-not [string]::IsNullOrWhiteSpace($currentRecordedBootId)) -and (-not [string]::IsNullOrWhiteSpace($currentBootId)) -and ($currentRecordedBootId -cne $currentBootId)',
      `if (($currentIdentity -eq $lockIdentity) -and ((($currentNow - $currentMtime) -gt ${staleAfterSeconds}) -or $currentRebooted)) {`,
      '$lockTombstone = "$lock.tombstone.$PID.$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"',
      'Move-Item -LiteralPath $lock -Destination $lockTombstone -ErrorAction Stop',
      '$successorStream = $null',
      `try { $null = New-Item -ItemType Directory -Path $lock -ErrorAction Stop; $successorOwner = Join-Path $lock '.owner'; $successorStream = [System.IO.File]::Open($successorOwner, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None); ${windowsWriteBootIdentityStatement('$lock', '$currentBootId')}; if ($currentRebooted) { 'REBOOT_OK' } else { 'OK' } } catch { 'BUSY' } finally { if ($null -ne $successorStream) { $successorStream.Dispose() } }`,
      "} else { 'BUSY' }",
      '}',
      "} catch { 'BUSY' } finally {",
      'if ($ownsSteal) {',
      '$stealParent = Split-Path -Parent $stealRoot',
      '$stealLeaf = Split-Path -Leaf $stealRoot',
      'Get-ChildItem -LiteralPath $stealParent -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name.StartsWith($stealLeaf + ".", [StringComparison]::Ordinal) } | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue',
      '}',
      'if ($null -ne $lockTombstone) { Remove-Item -LiteralPath $lockTombstone -Recurse -Force -ErrorAction SilentlyContinue }',
      '}',
      '}',
      "} catch { 'BUSY' }"
    ].join('; ')
  )
}

function posixCurrentBootIdentityAssignment(
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

function posixReadBootIdentity(lockDir: string, variableName: string): string {
  const markerPath = shellEscape(`${lockDir}/${INSTALL_LOCK_BOOT_ID_NAME}`)
  return [
    `${variableName}=$(head -c 128 ${markerPath} 2>/dev/null | tr -d '\\r\\n') || ${variableName}=;`,
    `if ! printf '%s\\n' "$${variableName}" | grep -Eq '^(linux:[0-9a-fA-F-]{1,64}:[0-9]{1,32}|darwin:[0-9]{1,32})$'; then ${variableName}=; fi;`
  ].join(' ')
}

function posixWriteBootIdentity(lockDir: string, variableName: string): string {
  const markerPath = shellEscape(`${lockDir}/${INSTALL_LOCK_BOOT_ID_NAME}`)
  const markerTempPrefix = shellEscape(`${lockDir}/${INSTALL_LOCK_BOOT_ID_NAME}.tmp`)
  return [
    `if [ -n "$${variableName}" ]; then`,
    `boot_marker_tmp=${markerTempPrefix}.$$;`,
    `if printf '%s\\n' "$${variableName}" > "$boot_marker_tmp" 2>/dev/null; then mv "$boot_marker_tmp" ${markerPath} 2>/dev/null || rm -f "$boot_marker_tmp"; else rm -f "$boot_marker_tmp"; fi;`,
    'fi;'
  ].join(' ')
}

function windowsCurrentBootIdentityStatements(variableName: string): string[] {
  return [
    `${variableName} = $null`,
    'try {',
    '$operatingSystem = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop',
    '$bootTicks = ([DateTime]$operatingSystem.LastBootUpTime).ToUniversalTime().Ticks',
    `${variableName} = "win32:$bootTicks"`,
    '} catch {}'
  ]
}

function windowsReadBootIdentityStatements(lockVariable: string, valueVariable: string): string[] {
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

function windowsWriteBootIdentityStatement(lockVariable: string, valueVariable: string): string {
  return [
    `if (-not [string]::IsNullOrWhiteSpace(${valueVariable})) {`,
    `$bootMarkerPath = Join-Path ${lockVariable} '${INSTALL_LOCK_BOOT_ID_NAME}'`,
    '$bootMarkerTemp = "$bootMarkerPath.tmp.$PID.$([Guid]::NewGuid().ToString(\'N\'))"',
    'try { [System.IO.File]::WriteAllText($bootMarkerTemp, ' +
      `${valueVariable}); [System.IO.File]::Move($bootMarkerTemp, $bootMarkerPath) } catch {} finally { Remove-Item -LiteralPath $bootMarkerTemp -Force -ErrorAction SilentlyContinue }`,
    '}'
  ].join('; ')
}

function posixLockAgeSecondsAssignment(lockDir: string): string {
  return `${posixLockMtimeSecondsAssignment(lockDir, 'mtime')} && now=$(date +%s) && age=$((now - mtime))`
}

function posixLockIdentityAssignment(lockDir: string, variableName: string): string {
  const escapedLockDir = shellEscape(lockDir)
  return `${variableName}=$(stat -c %Y:%i ${escapedLockDir} 2>/dev/null || stat -f %m:%i ${escapedLockDir} 2>/dev/null)`
}

function posixLockMtimeSecondsAssignment(lockDir: string, variableName: string): string {
  const escapedLockDir = shellEscape(lockDir)
  return `${variableName}=$(stat -c %Y ${escapedLockDir} 2>/dev/null || stat -f %m ${escapedLockDir} 2>/dev/null)`
}
