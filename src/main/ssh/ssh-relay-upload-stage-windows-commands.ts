import { powerShellCommand, powerShellLiteral } from './ssh-remote-powershell'
import {
  RELAY_UPLOAD_IDENTITY_FILE_NAME,
  RELAY_UPLOAD_OWNER_FILE_NAME,
  RELAY_UPLOAD_PROMOTION_RESULT_PREFIX,
  RELAY_UPLOAD_SLOT_RESULT_PREFIX,
  RELAY_UPLOAD_STAGE_POOL_NAME,
  RELAY_UPLOAD_STAGE_SLOT_COUNT,
  type RelayUploadStageSlot
} from './ssh-relay-upload-stage-contract'

export function reserveWindowsRelayUploadStageCommand(poolDir: string, owner: string): string {
  return powerShellCommand(
    [
      "$ErrorActionPreference = 'Stop'",
      ...windowsFileIdentityScript(),
      `$pool = ${powerShellLiteral(poolDir)}`,
      `$owner = ${powerShellLiteral(owner)}`,
      '$null = New-Item -ItemType Directory -Force -Path $pool',
      '$poolItem = Get-Item -LiteralPath $pool -Force -ErrorAction Stop',
      'if (-not $poolItem.PSIsContainer -or (($poolItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { throw "Unsafe relay upload stage pool" }',
      `foreach ($n in 0..${RELAY_UPLOAD_STAGE_SLOT_COUNT - 1}) {`,
      '$slot = Join-Path $pool ("slot-" + $n)',
      '$claim = Join-Path $pool ("claim-" + $n)',
      '$deleting = Join-Path $pool ("delete-" + $n)',
      '$slotExisting = Get-Item -LiteralPath $slot -Force -ErrorAction SilentlyContinue',
      '$claimExisting = Get-Item -LiteralPath $claim -Force -ErrorAction SilentlyContinue',
      '$deleteExisting = Get-Item -LiteralPath $deleting -Force -ErrorAction SilentlyContinue',
      'if (($null -ne $claimExisting) -or ($null -ne $slotExisting) -or ($null -ne $deleteExisting)) { continue }',
      'try {',
      '$null = New-Item -ItemType Directory -Path $slot -ErrorAction Stop',
      '$null = New-Item -ItemType Directory -Path (Join-Path $slot "payload") -ErrorAction Stop',
      '$identity = & $getFileIdentity $slot',
      `[System.IO.File]::WriteAllText((Join-Path $slot ${powerShellLiteral(RELAY_UPLOAD_OWNER_FILE_NAME)}), $owner, [System.Text.UTF8Encoding]::new($false))`,
      `[System.IO.File]::WriteAllText((Join-Path $slot ${powerShellLiteral(RELAY_UPLOAD_IDENTITY_FILE_NAME)}), $identity, [System.Text.UTF8Encoding]::new($false))`,
      `[System.IO.File]::WriteAllText((Join-Path $slot ${powerShellLiteral(owner)}), '', [System.Text.UTF8Encoding]::new($false))`,
      `Write-Output (${powerShellLiteral(RELAY_UPLOAD_SLOT_RESULT_PREFIX)} + $owner + ':slot-' + $n)`,
      'exit 0',
      '} catch { continue }',
      '}',
      `throw ${powerShellLiteral(`Orca relay upload staging quota is full; reconnect after 40 minutes or inspect .orca-remote/${RELAY_UPLOAD_STAGE_POOL_NAME}`)}`
    ].join('\n')
  )
}

function windowsFileIdentityScript(): string[] {
  return [
    "if ($env:OS -eq 'Windows_NT') {",
    "if ($null -eq ('OrcaRelayUploadFileIdentity' -as [type])) {",
    "Add-Type -TypeDefinition @'",
    'using System;',
    'using System.ComponentModel;',
    'using System.Runtime.InteropServices;',
    'using Microsoft.Win32.SafeHandles;',
    'public static class OrcaRelayUploadFileIdentity {',
    '[StructLayout(LayoutKind.Sequential)] struct Info { public uint Attr; public System.Runtime.InteropServices.ComTypes.FILETIME C; public System.Runtime.InteropServices.ComTypes.FILETIME A; public System.Runtime.InteropServices.ComTypes.FILETIME W; public uint Vol; public uint SizeH; public uint SizeL; public uint Links; public uint IndexH; public uint IndexL; }',
    '[DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr sec, uint creation, uint flags, IntPtr template);',
    '[DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Info info);',
    'public static string Read(string path) {',
    'using (var handle = CreateFileW(path, 0, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero)) {',
    'if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());',
    'Info info; if (!GetFileInformationByHandle(handle, out info)) throw new Win32Exception(Marshal.GetLastWin32Error());',
    'return info.Vol.ToString("x") + ":" + info.IndexH.ToString("x") + ":" + info.IndexL.ToString("x");',
    '}',
    '}',
    '}',
    "'@",
    '}',
    '$getFileIdentity = { param($path) [OrcaRelayUploadFileIdentity]::Read($path) }',
    '} else {',
    '$getFileIdentity = { param($path) $resolved = (Get-Item -LiteralPath $path -Force -ErrorAction Stop).FullName; $value = & /usr/bin/stat -f "%i" -- $resolved 2>$null; if ($LASTEXITCODE -ne 0) { $value = & /usr/bin/stat -c "%i" -- $resolved }; ([string]$value).Trim() }',
    '}'
  ]
}

function windowsClaimPrelude(stage: RelayUploadStageSlot): string[] {
  return [
    `$slot = ${powerShellLiteral(stage.slotDir)}`,
    `$claim = ${powerShellLiteral(stage.claimDir)}`,
    `$deleting = ${powerShellLiteral(stage.deleteDir)}`,
    `$pool = ${powerShellLiteral(stage.poolDir)}`,
    '$poolItem = Get-Item -LiteralPath $pool -Force -ErrorAction SilentlyContinue',
    'if (($null -eq $poolItem) -or -not $poolItem.PSIsContainer -or (($poolItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { exit 0 }',
    '$claimBefore = Get-Item -LiteralPath $claim -Force -ErrorAction SilentlyContinue',
    '$deleteBefore = Get-Item -LiteralPath $deleting -Force -ErrorAction SilentlyContinue',
    '$slotBefore = Get-Item -LiteralPath $slot -Force -ErrorAction SilentlyContinue',
    'if (($null -ne $claimBefore) -or ($null -ne $deleteBefore) -or ($null -eq $slotBefore)) { exit 0 }',
    'Move-Item -LiteralPath $slot -Destination $claim -ErrorAction Stop'
  ]
}

function windowsOwnershipScript(
  owner: string,
  requirePayload: boolean,
  pathExpression = '$claim'
): string[] {
  return [
    `$expectedOwner = ${powerShellLiteral(owner)}`,
    `$ownedPath = ${pathExpression}`,
    `$ownerPath = Join-Path $ownedPath ${powerShellLiteral(RELAY_UPLOAD_OWNER_FILE_NAME)}`,
    `$identityPath = Join-Path $ownedPath ${powerShellLiteral(RELAY_UPLOAD_IDENTITY_FILE_NAME)}`,
    '$claimItem = Get-Item -LiteralPath $ownedPath -Force -ErrorAction SilentlyContinue',
    '$ownerItem = Get-Item -LiteralPath $ownerPath -Force -ErrorAction SilentlyContinue',
    '$identityItem = Get-Item -LiteralPath $identityPath -Force -ErrorAction SilentlyContinue',
    '$actualOwner = if ($null -ne $ownerItem) { [System.IO.File]::ReadAllText($ownerPath).Trim() } else { "" }',
    '$expectedIdentity = if ($null -ne $identityItem) { [System.IO.File]::ReadAllText($identityPath).Trim() } else { "" }',
    '$actualIdentity = if ($null -ne $claimItem) { & $getFileIdentity $ownedPath } else { "" }',
    '$owned = ($null -ne $claimItem) -and $claimItem.PSIsContainer -and (($claimItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) -and ($null -ne $ownerItem) -and -not $ownerItem.PSIsContainer -and (($ownerItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) -and ($null -ne $identityItem) -and -not $identityItem.PSIsContainer -and (($identityItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) -and ($actualOwner -ceq $expectedOwner) -and ($actualIdentity -ceq $expectedIdentity)',
    ...(requirePayload
      ? [
          '$payload = Join-Path $ownedPath "payload"',
          '$payloadItem = Get-Item -LiteralPath $payload -Force -ErrorAction SilentlyContinue',
          '$reparse = $null',
          'if (($null -ne $payloadItem) -and $payloadItem.PSIsContainer -and (($payloadItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0)) {',
          '$reparse = Get-ChildItem -LiteralPath $payload -Force -Recurse -ErrorAction Stop | Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 } | Select-Object -First 1',
          '}',
          '$owned = $owned -and ($null -ne $payloadItem) -and $payloadItem.PSIsContainer -and (($payloadItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) -and ($null -eq $reparse)'
        ]
      : [])
  ]
}

function windowsRestoreClaim(): string {
  return 'if (($null -eq (Get-Item -LiteralPath $slot -Force -ErrorAction SilentlyContinue)) -and ($null -ne (Get-Item -LiteralPath $claim -Force -ErrorAction SilentlyContinue))) { Move-Item -LiteralPath $claim -Destination $slot -ErrorAction SilentlyContinue }'
}

function windowsStaleOwnershipScript(pathExpression: string): string[] {
  return [
    `$ownedPath = ${pathExpression}`,
    `$ownerPath = Join-Path $ownedPath ${powerShellLiteral(RELAY_UPLOAD_OWNER_FILE_NAME)}`,
    `$identityPath = Join-Path $ownedPath ${powerShellLiteral(RELAY_UPLOAD_IDENTITY_FILE_NAME)}`,
    '$ownedItem = Get-Item -LiteralPath $ownedPath -Force -ErrorAction SilentlyContinue',
    '$ownerItem = Get-Item -LiteralPath $ownerPath -Force -ErrorAction SilentlyContinue',
    '$identityItem = Get-Item -LiteralPath $identityPath -Force -ErrorAction SilentlyContinue',
    '$actualOwner = if ($null -ne $ownerItem) { [System.IO.File]::ReadAllText($ownerPath).Trim() } else { "" }',
    '$expectedIdentity = if ($null -ne $identityItem) { [System.IO.File]::ReadAllText($identityPath).Trim() } else { "" }',
    '$actualIdentity = if ($null -ne $ownedItem) { & $getFileIdentity $ownedPath } else { "" }',
    "$owned = ($null -ne $ownedItem) -and $ownedItem.PSIsContainer -and (($ownedItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) -and ($null -ne $ownerItem) -and -not $ownerItem.PSIsContainer -and (($ownerItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) -and ($null -ne $identityItem) -and -not $identityItem.PSIsContainer -and (($identityItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) -and ($actualIdentity -ceq $expectedIdentity) -and ($ownerItem.LastWriteTimeUtc -lt $cutoff) -and ($actualOwner -match '^\\.sftp-namespace-[0-9a-f]{32}$')",
    '$reparse = $null',
    'if ($owned) {',
    '$reparse = Get-ChildItem -LiteralPath $ownedPath -Force -Recurse -ErrorAction Stop | Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 } | Select-Object -First 1',
    '}',
    '$owned = $owned -and ($null -eq $reparse)'
  ]
}

function windowsDeleteOwnedClaimScript(owner: string): string[] {
  return [
    '$deleteBefore = Get-Item -LiteralPath $deleting -Force -ErrorAction SilentlyContinue',
    'if ($null -ne $deleteBefore) { exit 0 }',
    'Move-Item -LiteralPath $claim -Destination $deleting -ErrorAction Stop',
    ...windowsOwnershipScript(owner, true, '$deleting'),
    'if ($owned) {',
    'Remove-Item -LiteralPath $deleting -Recurse -Force -ErrorAction Stop',
    '} elseif (($null -eq (Get-Item -LiteralPath $claim -Force -ErrorAction SilentlyContinue)) -and ($null -ne (Get-Item -LiteralPath $deleting -Force -ErrorAction SilentlyContinue))) {',
    'Move-Item -LiteralPath $deleting -Destination $claim -ErrorAction SilentlyContinue',
    '}'
  ]
}

export function promoteWindowsRelayUploadStageCommand(
  stage: RelayUploadStageSlot,
  owner: string,
  destinationDir: string
): string {
  return powerShellCommand(
    [
      "$ErrorActionPreference = 'Stop'",
      ...windowsFileIdentityScript(),
      ...windowsClaimPrelude(stage),
      ...windowsOwnershipScript(owner, true),
      'if (-not $owned) {',
      windowsRestoreClaim(),
      `Write-Output (${powerShellLiteral(RELAY_UPLOAD_PROMOTION_RESULT_PREFIX)} + $expectedOwner + ':OWNERSHIP_LOST')`,
      'exit 0',
      '}',
      `Get-ChildItem -LiteralPath $payload -Force -ErrorAction Stop | Copy-Item -Destination ${powerShellLiteral(destinationDir)} -Recurse -Force -ErrorAction Stop`,
      ...windowsDeleteOwnedClaimScript(owner),
      `Write-Output (${powerShellLiteral(RELAY_UPLOAD_PROMOTION_RESULT_PREFIX)} + $expectedOwner + ':PROMOTED')`
    ].join('\n')
  )
}

export function cleanupWindowsRelayUploadStageCommand(
  stage: RelayUploadStageSlot,
  owner: string
): string {
  return powerShellCommand(
    [
      "$ErrorActionPreference = 'Stop'",
      ...windowsFileIdentityScript(),
      ...windowsClaimPrelude(stage),
      ...windowsOwnershipScript(owner, true),
      'if ($owned) {',
      ...windowsDeleteOwnedClaimScript(owner),
      '} else {',
      windowsRestoreClaim(),
      '}'
    ].join('\n')
  )
}

export function recoverWindowsRelayUploadStageCommand(
  poolDir: string,
  staleSeconds: number
): string {
  return powerShellCommand(
    [
      "$ErrorActionPreference = 'Stop'",
      ...windowsFileIdentityScript(),
      `$pool = ${powerShellLiteral(poolDir)}`,
      `$cutoff = [DateTime]::UtcNow.AddSeconds(-${staleSeconds})`,
      '$poolItem = Get-Item -LiteralPath $pool -Force -ErrorAction SilentlyContinue',
      'if (($null -eq $poolItem) -or -not $poolItem.PSIsContainer -or (($poolItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { exit 0 }',
      `foreach ($n in 0..${RELAY_UPLOAD_STAGE_SLOT_COUNT - 1}) {`,
      '$slot = Join-Path $pool ("slot-" + $n)',
      '$claim = Join-Path $pool ("claim-" + $n)',
      '$deleting = Join-Path $pool ("delete-" + $n)',
      ...windowsStaleOwnershipScript('$deleting'),
      'if ($owned) {',
      'Remove-Item -LiteralPath $deleting -Recurse -Force -ErrorAction Stop',
      'exit 0',
      '}',
      `$slotOwner = Join-Path $slot ${powerShellLiteral(RELAY_UPLOAD_OWNER_FILE_NAME)}`,
      '$slotItem = Get-Item -LiteralPath $slot -Force -ErrorAction SilentlyContinue',
      '$slotOwnerItem = Get-Item -LiteralPath $slotOwner -Force -ErrorAction SilentlyContinue',
      '$claimItem = Get-Item -LiteralPath $claim -Force -ErrorAction SilentlyContinue',
      '$deleteItem = Get-Item -LiteralPath $deleting -Force -ErrorAction SilentlyContinue',
      'if (($null -eq $claimItem) -and ($null -eq $deleteItem) -and ($null -ne $slotItem) -and $slotItem.PSIsContainer -and (($slotItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) -and ($null -ne $slotOwnerItem) -and -not $slotOwnerItem.PSIsContainer -and (($slotOwnerItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) -and $slotOwnerItem.LastWriteTimeUtc -lt $cutoff) {',
      'Move-Item -LiteralPath $slot -Destination $claim -ErrorAction SilentlyContinue',
      '}',
      ...windowsStaleOwnershipScript('$claim'),
      'if ($owned -and ($null -eq (Get-Item -LiteralPath $deleting -Force -ErrorAction SilentlyContinue))) {',
      'Move-Item -LiteralPath $claim -Destination $deleting -ErrorAction Stop',
      ...windowsStaleOwnershipScript('$deleting'),
      'if (-not $owned) {',
      'if (($null -eq (Get-Item -LiteralPath $claim -Force -ErrorAction SilentlyContinue)) -and ($null -ne (Get-Item -LiteralPath $deleting -Force -ErrorAction SilentlyContinue))) { Move-Item -LiteralPath $deleting -Destination $claim -ErrorAction SilentlyContinue }',
      'continue',
      '}',
      'Remove-Item -LiteralPath $deleting -Recurse -Force -ErrorAction Stop',
      'exit 0',
      '}',
      windowsRestoreClaim(),
      '}'
    ].join('\n')
  )
}
