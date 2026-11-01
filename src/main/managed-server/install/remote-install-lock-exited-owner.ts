import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import type { InstallLockOwnerFile } from './remote-install-lock-commands'
import { quotePowerShellLiteral as powerShellLiteral } from '../../../shared/powershell-native-argument'
import {
  posixStateMutationGroupRecord,
  posixStateMutationPidRecord
} from '../host-state/orcad-state-mutation-owner-record'

/** Verify exited-holder token and quiet time during takeover; optionally fence state mutations. */
export type InstallLockExitedOwner = InstallLockOwnerFile & {
  quietSeconds: number
  mutationLock?: string
}

export function posixCheck(
  lockDir: string,
  exitedOwner: InstallLockExitedOwner | undefined,
  ageVariable: string,
  variableName: string
): string {
  if (!exitedOwner) {
    return `${variableName}=0;`
  }
  const ownerPath = quotePosixShell(`${lockDir.replace(/\/+$/u, '')}/${exitedOwner.fileName}`)
  return (
    `${variableName}=0; if [ "$(cat ${ownerPath} 2>/dev/null)" = ${quotePosixShell(exitedOwner.token)} ] && ` +
    `[ "\${${ageVariable}:-0}" -gt ${exitedOwner.quietSeconds} ] 2>/dev/null; then ${variableName}=1; fi;`
  )
}

export function windowsCheck(
  exitedOwner: InstallLockExitedOwner | undefined,
  ageExpression: string,
  variableName: string
): string {
  if (!exitedOwner) {
    return `${variableName} = $false`
  }
  const ownerPath = `(Join-Path $lock ${powerShellLiteral(exitedOwner.fileName)})`
  return (
    `${variableName} = $false; try { ${variableName} = (${ageExpression} -gt ${exitedOwner.quietSeconds}) -and ` +
    `([System.IO.File]::ReadAllText(${ownerPath}) -ceq ${powerShellLiteral(exitedOwner.token)}) } catch {}`
  )
}

/** Hold mutation admission, then reread owner and lock identity to reject heartbeat/reownership races.
 * Refuse every existing mutation lock; only proven exit permits its removal. */
function posixMutationAdmission(
  lockDir: string,
  exitedOwner: InstallLockExitedOwner | undefined,
  identityAssignment: (lockDir: string, variableName: string) => string
): string {
  if (!exitedOwner?.mutationLock) {
    return ''
  }
  const ownerPath = quotePosixShell(`${lockDir.replace(/\/+$/u, '')}/${exitedOwner.fileName}`)
  return [
    'if [ "$current_exited" = 1 ]; then current_exited=0;',
    `if mkdir ${quotePosixShell(exitedOwner.mutationLock)} 2>/dev/null; then held_mutation=${quotePosixShell(exitedOwner.mutationLock)};`,
    `owns_mutation=1; ${posixStateMutationPidRecord('"$held_mutation"', 'owns_mutation=0;')}`,
    posixStateMutationGroupRecord('"$held_mutation"'),
    `[ "$owns_mutation" = 1 ] && [ "$(cat ${ownerPath} 2>/dev/null)" = ${quotePosixShell(exitedOwner.token)} ] &&`,
    `${identityAssignment(lockDir, 'again_key')} && [ "$again_key" = "$lock_key" ] && current_exited=1;`,
    'fi; fi;'
  ].join(' ')
}

export function posixRelease(exitedOwner: InstallLockExitedOwner | undefined): string {
  return exitedOwner?.mutationLock
    ? ' [ -n "$held_mutation" ] && [ "$(cat "$held_mutation/pid" 2>/dev/null)" = "$$" ] && rm -rf "$held_mutation";'
    : ''
}

/** Atomically publish ownership; a live PID without creation time remains unverifiable. */
function windowsMutationAdmission(exitedOwner: InstallLockExitedOwner | undefined): string[] {
  if (!exitedOwner?.mutationLock) {
    return []
  }
  const mutation = powerShellLiteral(exitedOwner.mutationLock)
  const ownerPath = `(Join-Path $lock ${powerShellLiteral(exitedOwner.fileName)})`
  return [
    '$heldMutation = $null',
    'if ($currentExited) { $currentExited = $false; try {',
    `$null = New-Item -ItemType Directory -Force -Path ${mutation} -ErrorAction Stop`,
    `$mutationOwnerTemp = Join-Path ${mutation} "owner.json.$PID.tmp"`,
    "[System.IO.File]::WriteAllText($mutationOwnerTemp, '{\"pid\":' + $PID + '}')",
    `[System.IO.File]::Move($mutationOwnerTemp, (Join-Path ${mutation} 'owner.json'))`,
    `$heldMutation = ${mutation}`,
    `$ownerNow = [System.IO.File]::ReadAllText(${ownerPath})`,
    '$again = Get-Item -LiteralPath $lock -ErrorAction Stop',
    '$againIdentity = "$(([DateTimeOffset]$again.LastWriteTimeUtc).ToUnixTimeSeconds()):$($again.CreationTimeUtc.Ticks)"',
    `$currentExited = ($ownerNow -ceq ${powerShellLiteral(exitedOwner.token)}) -and ($againIdentity -eq $lockIdentity)`,
    '} catch {} }'
  ]
}

export function windowsRelease(exitedOwner: InstallLockExitedOwner | undefined): string[] {
  return exitedOwner?.mutationLock
    ? [
        "if ($null -ne $heldMutation) { try { if (([System.IO.File]::ReadAllText((Join-Path $heldMutation 'owner.json')) | ConvertFrom-Json).pid -eq $PID) { Remove-Item -LiteralPath $heldMutation -Recurse -Force -ErrorAction SilentlyContinue } } catch {} }"
      ]
    : []
}

export function posixClaimCheck(
  lockDir: string,
  exitedOwner: InstallLockExitedOwner | undefined,
  identityAssignment: (lockDir: string, variableName: string) => string
): string {
  return [
    posixCheck(lockDir, exitedOwner, 'current_age', 'current_exited'),
    posixMutationAdmission(lockDir, exitedOwner, identityAssignment)
  ].join(' ')
}

export function windowsClaimCheck(exitedOwner: InstallLockExitedOwner | undefined): string[] {
  return [
    windowsCheck(exitedOwner, '($currentNow - $currentMtime)', '$currentExited'),
    ...windowsMutationAdmission(exitedOwner)
  ]
}
