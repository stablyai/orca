import { shellEscape } from './ssh-connection-utils'
import { powerShellCommand, powerShellLiteral } from './ssh-remote-powershell'
import { isWindowsRemoteHost, type RemoteHostPlatform } from './ssh-remote-platform'

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
    return `mkdir ${shellEscape(lockDir)} 2>&1 && echo OK || echo BUSY`
  }
  // New-Item has no -LiteralPath parameter; using it breaks stock Windows PowerShell.
  return powerShellCommand(
    `$ErrorActionPreference = "Stop"; try { $null = New-Item -ItemType Directory -Path ${powerShellLiteral(lockDir)}; 'OK' } catch { 'BUSY' }`
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
    return posixStealInstallLockCommand(lockDir, staleAfterSeconds)
  }
  return windowsStealInstallLockCommand(lockDir, staleAfterSeconds)
}

function posixStealInstallLockCommand(lockDir: string, staleAfterSeconds: number): string {
  const escapedLockDir = shellEscape(lockDir)
  const escapedStealLockPrefix = shellEscape(`${lockDir}.steal`)
  return [
    `${posixLockIdentityAssignment(lockDir, 'lock_key')} && mtime=\${lock_key%%:*} && now=$(date +%s) && age=$((now - mtime)) || age=0;`,
    `if [ "\${age:-0}" -le ${staleAfterSeconds} ] 2>/dev/null; then echo BUSY; else`,
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
    `if [ "$current_key" = "$lock_key" ] && [ "\${current_age:-0}" -gt ${staleAfterSeconds} ] 2>/dev/null; then`,
    `lock_tombstone=${escapedLockDir}.tombstone.$$.$(date +%s);`,
    `if [ ! -e "$lock_tombstone" ] && mv ${escapedLockDir} "$lock_tombstone" 2>/dev/null; then mkdir ${escapedLockDir} 2>&1 && echo OK || echo BUSY; else echo BUSY; fi;`,
    'else echo BUSY; fi;',
    'else echo BUSY; fi; fi'
  ].join(' ')
}

function windowsStealInstallLockCommand(lockDir: string, staleAfterSeconds: number): string {
  return powerShellCommand(
    [
      `$lock = ${powerShellLiteral(lockDir)}`,
      'try {',
      '$item = Get-Item -LiteralPath $lock -ErrorAction Stop',
      '$mtime = ([DateTimeOffset]$item.LastWriteTimeUtc).ToUnixTimeSeconds()',
      '$lockIdentity = "${mtime}:$($item.CreationTimeUtc.Ticks)"',
      '$now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()',
      `if (($now - $mtime) -le ${staleAfterSeconds}) { 'BUSY' } else {`,
      '$stealRoot = "$lock.steal"',
      '$stealGeneration = 0',
      '$steal = "$stealRoot.$stealGeneration"',
      '$ownsSteal = $false',
      '$lockTombstone = $null',
      'try {',
      'while (-not $ownsSteal) {',
      'try {',
      '$null = New-Item -ItemType Directory -Path $steal -ErrorAction Stop',
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
      `if (($currentIdentity -eq $lockIdentity) -and (($currentNow - $currentMtime) -gt ${staleAfterSeconds})) {`,
      '$lockTombstone = "$lock.tombstone.$PID.$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"',
      'Move-Item -LiteralPath $lock -Destination $lockTombstone -ErrorAction Stop',
      "try { $null = New-Item -ItemType Directory -Path $lock -ErrorAction Stop; 'OK' } catch { 'BUSY' }",
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
