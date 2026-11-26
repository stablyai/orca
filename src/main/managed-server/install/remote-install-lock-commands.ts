import { quotePosixShell } from '../../../shared/shell/launch/shell-argument-quoting'
import { powerShellCommand } from '../../ssh/remote-exec/ssh-remote-powershell'
import { quotePowerShellLiteral as powerShellLiteral } from '../../../shared/shell/launch/powershell-native-argument'
import {
  isWindowsRemoteHost,
  type RemoteHostPlatform
} from '../../ssh/remote-host/ssh-remote-platform'
import * as exitedOwnerSteal from './remote-install-lock-exited-owner'
import {
  posixCurrentBootIdentityAssignment,
  posixReadBootIdentity,
  posixWriteBootIdentity,
  windowsCurrentBootIdentityStatements,
  windowsReadBootIdentityStatements,
  windowsWriteBootIdentityStatement
} from './remote-install-lock-boot-identity'
import {
  posixHolderStealParts,
  type InstallLockHolderExit
} from './remote-install-lock-holder-commands'

export function acquireInstallLockParentCommand(
  host: RemoteHostPlatform,
  remoteRelayDir: string
): string {
  if (!isWindowsRemoteHost(host)) {
    return `mkdir -p ${quotePosixShell(remoteRelayDir)}`
  }
  return powerShellCommand(
    `$null = New-Item -ItemType Directory -Force -Path ${powerShellLiteral(remoteRelayDir)}`
  )
}

/** Written in the same command that acquires the lock. */
export type InstallLockOwnerFile = { fileName: string; token: string }

export function tryCreateInstallLockCommand(
  host: RemoteHostPlatform,
  lockDir: string,
  owner?: InstallLockOwnerFile
): string {
  if (!isWindowsRemoteHost(host)) {
    return [
      `if mkdir ${quotePosixShell(lockDir)} 2>/dev/null; then`,
      posixCurrentBootIdentityAssignment(host, 'current_boot_id'),
      posixWriteBootIdentity(lockDir, 'current_boot_id'),
      ...posixWriteOwner(lockDir, owner),
      'echo OK;',
      'else echo BUSY; fi'
    ].join(' ')
  }
  // Older clients need the directory marker; an atomic child file arbitrates PowerShell 5.1 races.
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
      ...(owner ? [windowsWriteOwner(owner).replace(/; $/u, '')] : []),
      "'OK'",
      '}',
      `} catch { 'BUSY' } finally { if ($null -ne $stream) { $stream.Dispose() } }`
    ].join('; ')
  )
}

export function probeInstallLockExistsCommand(host: RemoteHostPlatform, lockPath: string): string {
  if (!isWindowsRemoteHost(host)) {
    return `test -e ${quotePosixShell(lockPath)} && echo LOCKED || echo OPEN`
  }
  // Accept prerelease file locks as well as directory-plus-owner locks.
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

/** Backdate abandoned locks to permit immediate stale takeover. */
export function orphanInstallLockCommand(host: RemoteHostPlatform, lockDir: string): string {
  if (!isWindowsRemoteHost(host)) {
    return `touch -m -t 200001010000 ${quotePosixShell(lockDir)}`
  }
  return powerShellCommand(
    `(Get-Item -LiteralPath ${powerShellLiteral(lockDir)} -ErrorAction Stop).LastWriteTimeUtc = ` +
      '[DateTime]::SpecifyKind([DateTime]::new(2000, 1, 1), [DateTimeKind]::Utc)'
  )
}

// Replacement owner tokens let displaced holders detect takeover.
export function tryStealInstallLockCommand(
  host: RemoteHostPlatform,
  lockDir: string,
  staleAfterSeconds: number,
  owner?: InstallLockOwnerFile,
  exitedOwner?: exitedOwnerSteal.InstallLockExitedOwner,
  /** POSIX only: a flock-backed lock generation whose holder a probe found gone. */
  exitedHolder?: InstallLockHolderExit
): string {
  if (!isWindowsRemoteHost(host)) {
    return posixStealInstallLockCommand(
      host,
      lockDir,
      staleAfterSeconds,
      owner,
      exitedOwner,
      exitedHolder
    )
  }
  return windowsStealInstallLockCommand(lockDir, staleAfterSeconds, owner, exitedOwner)
}

function posixStealInstallLockCommand(
  host: RemoteHostPlatform,
  lockDir: string,
  staleAfterSeconds: number,
  owner?: InstallLockOwnerFile,
  exitedOwner?: exitedOwnerSteal.InstallLockExitedOwner,
  exitedHolder?: InstallLockHolderExit
): string {
  const escapedLockDir = quotePosixShell(lockDir)
  const holder = posixHolderStealParts(lockDir, owner, exitedHolder)
  const escapedStealLockPrefix = quotePosixShell(`${lockDir}.steal`)
  return [
    posixCurrentBootIdentityAssignment(host, 'current_boot_id'),
    `${posixReadBootIdentity(lockDir, 'recorded_boot_id')}`,
    'rebooted=0;',
    'if [ -n "$recorded_boot_id" ] && [ -n "$current_boot_id" ] && [ "$recorded_boot_id" != "$current_boot_id" ]; then rebooted=1; fi;',
    `${posixLockIdentityAssignment(lockDir, 'lock_key')} && mtime=\${lock_key%%:*} && now=$(date +%s) && age=$((now - mtime)) || age=0;`,
    exitedOwnerSteal.posixCheck(lockDir, exitedOwner, 'age', 'exited'),
    ...(holder.check ? [holder.check] : []),
    `if [ "\${age:-0}" -le ${staleAfterSeconds} ] 2>/dev/null && [ "$rebooted" != 1 ] && [ "$exited" != 1 ]${holder.gate}; then echo BUSY; else`,
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
    `held_mutation=; trap 'rm -rf "$steal_root".* 2>/dev/null || true; rm -rf "$lock_tombstone" 2>/dev/null || true;${exitedOwnerSteal.posixRelease(exitedOwner)}' EXIT;`,
    `${posixLockIdentityAssignment(lockDir, 'current_key')} && current_mtime=\${current_key%%:*} && current_now=$(date +%s) && current_age=$((current_now - current_mtime)) || current_age=0;`,
    `${posixReadBootIdentity(lockDir, 'current_recorded_boot_id')}`,
    'current_rebooted=0;',
    'if [ -n "$current_recorded_boot_id" ] && [ -n "$current_boot_id" ] && [ "$current_recorded_boot_id" != "$current_boot_id" ]; then current_rebooted=1; fi;',
    exitedOwnerSteal.posixClaimCheck(lockDir, exitedOwner, posixLockIdentityAssignment),
    ...(holder.claimCheck ? [holder.claimCheck] : []),
    `if [ "$current_key" = "$lock_key" ] && { [ "\${current_age:-0}" -gt ${staleAfterSeconds} ] 2>/dev/null || [ "$current_rebooted" = 1 ] || [ "$current_exited" = 1 ]${holder.claim}; }; then`,
    `lock_tombstone=${escapedLockDir}.tombstone.$$.$(date +%s);`,
    `if [ ! -e "$lock_tombstone" ] && mv ${escapedLockDir} "$lock_tombstone" 2>/dev/null; then`,
    `if mkdir ${escapedLockDir} 2>/dev/null; then`,
    posixWriteBootIdentity(lockDir, 'current_boot_id'),
    ...posixWriteOwner(lockDir, owner),
    `if [ "$current_rebooted" = 1 ]; then echo REBOOT_OK; elif [ "$current_exited" = 1 ]; then echo EXITED_OWNER_OK;${holder.reason} else echo OK; fi;`,
    'else echo BUSY; fi; else echo BUSY; fi;',
    'else echo BUSY; fi;',
    'else echo BUSY; fi; fi'
  ].join(' ')
}

function windowsStealInstallLockCommand(
  lockDir: string,
  staleAfterSeconds: number,
  owner?: InstallLockOwnerFile,
  exitedOwner?: exitedOwnerSteal.InstallLockExitedOwner
): string {
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
      exitedOwnerSteal.windowsCheck(exitedOwner, '($now - $mtime)', '$exited'),
      `if ((($now - $mtime) -le ${staleAfterSeconds}) -and (-not $rebooted) -and (-not $exited)) { 'BUSY' } else {`,
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
      ...exitedOwnerSteal.windowsClaimCheck(exitedOwner),
      `if (($currentIdentity -eq $lockIdentity) -and ((($currentNow - $currentMtime) -gt ${staleAfterSeconds}) -or $currentRebooted -or $currentExited)) {`,
      '$lockTombstone = "$lock.tombstone.$PID.$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"',
      'Move-Item -LiteralPath $lock -Destination $lockTombstone -ErrorAction Stop',
      '$successorStream = $null',
      `try { $null = New-Item -ItemType Directory -Path $lock -ErrorAction Stop; $successorOwner = Join-Path $lock '.owner'; $successorStream = [System.IO.File]::Open($successorOwner, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None); ${windowsWriteBootIdentityStatement('$lock', '$currentBootId')}; ${windowsWriteOwner(owner)}if ($currentRebooted) { 'REBOOT_OK' } elseif ($currentExited) { 'EXITED_OWNER_OK' } else { 'OK' } } catch { 'BUSY' } finally { if ($null -ne $successorStream) { $successorStream.Dispose() } }`,
      "} else { 'BUSY' }",
      '}',
      "} catch { 'BUSY' } finally {",
      'if ($ownsSteal) {',
      '$stealParent = Split-Path -Parent $stealRoot',
      '$stealLeaf = Split-Path -Leaf $stealRoot',
      'Get-ChildItem -LiteralPath $stealParent -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name.StartsWith($stealLeaf + ".", [StringComparison]::Ordinal) } | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue',
      '}',
      'if ($null -ne $lockTombstone) { Remove-Item -LiteralPath $lockTombstone -Recurse -Force -ErrorAction SilentlyContinue }',
      ...exitedOwnerSteal.windowsRelease(exitedOwner),
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
  const escapedLockDir = quotePosixShell(lockDir)
  return `${variableName}=$(stat -c %Y:%i ${escapedLockDir} 2>/dev/null || stat -f %m:%i ${escapedLockDir} 2>/dev/null)`
}

function posixLockMtimeSecondsAssignment(lockDir: string, variableName: string): string {
  const escapedLockDir = quotePosixShell(lockDir)
  return `${variableName}=$(stat -c %Y ${escapedLockDir} 2>/dev/null || stat -f %m ${escapedLockDir} 2>/dev/null)`
}

function posixWriteOwner(lockDir: string, owner?: InstallLockOwnerFile): string[] {
  if (!owner) {
    return []
  }
  const ownerPath = `${lockDir.replace(/\/+$/u, '')}/${owner.fileName}`
  return [`printf %s ${quotePosixShell(owner.token)} > ${quotePosixShell(ownerPath)};`]
}

function windowsWriteOwner(owner?: InstallLockOwnerFile): string {
  return owner
    ? `[System.IO.File]::WriteAllText((Join-Path $lock ${powerShellLiteral(owner.fileName)}), ${powerShellLiteral(owner.token)}); `
    : ''
}
