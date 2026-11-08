// Query process image paths, not names: unrelated node.exe processes must not hold runtimes.
// Keep each inventory/sweep to one PowerShell invocation; see docs/reference/windows-edr-posture.md.
import {
  ORCAD_NODE_RUNTIME_DIR_PREFIX,
  ORCAD_NODE_RUNTIME_MARKER_FILENAME,
  ORCAD_RUNTIMES_DIRNAME
} from '../../../shared/orcad-artifacts'
import { RUNTIME_STORE_STAGE_PREFIX } from './orcad-remote-node-runtime'
import {
  INVENTORY_OK,
  MAX_DIRS,
  REFS_ERR,
  RUNTIME_REF_NODE_PREFIX,
  RUNTIME_STORE_TOMBSTONE_PREFIX,
  runtimeStoreInventoryCommand
} from './remote-node-runtime-store-inventory'
import { RELAY_REMOTE_DIR } from '../../ssh/remote-exec/remote-frame-protocol'
import {
  isWindowsRemoteHost,
  joinRemotePath,
  type RemoteHostPlatform
} from '../../ssh/ssh-remote-platform'
import { powerShellCommand } from '../../ssh/ssh-remote-powershell'
import { quotePowerShellLiteral as powerShellLiteral } from '../../../shared/powershell-native-argument'

const REPARSE = '[IO.FileAttributes]::ReparsePoint'

export function hostRuntimeStoreInventoryCommand(
  host: RemoteHostPlatform,
  remoteHome: string
): string {
  return isWindowsRemoteHost(host)
    ? windowsRuntimeStoreInventoryCommand(joinRemotePath(host, remoteHome, RELAY_REMOTE_DIR))
    : runtimeStoreInventoryCommand(host, remoteHome)
}

export function windowsRuntimeStoreInventoryCommand(root: string): string {
  const fail = `Write-Output ${powerShellLiteral(REFS_ERR)}; exit 0`
  return powerShellCommand(
    [
      "$ProgressPreference = 'SilentlyContinue'",
      `$root = ${powerShellLiteral(root)}`,
      `$rt = Join-Path $root ${powerShellLiteral(ORCAD_RUNTIMES_DIRNAME)}`,
      `if (-not (Test-Path -LiteralPath $rt -PathType Container)) { Write-Output ${powerShellLiteral(INVENTORY_OK)}; exit 0 }`,
      // Newer clients' installs may reference runtimes outside known prefixes.
      `try { $dirs = @(Get-ChildItem -LiteralPath $root -Force -Directory -ErrorAction Stop | Where-Object { $_.Name -ne ${powerShellLiteral(ORCAD_RUNTIMES_DIRNAME)} }) } catch { ${fail} }`,
      `if ($dirs.Count -gt ${MAX_DIRS}) { ${fail} }`,
      'foreach ($d in $dirs) {',
      "Write-Output ('DIR ' + $d.Name)",
      `$marker = Join-Path $d.FullName ${powerShellLiteral(ORCAD_NODE_RUNTIME_MARKER_FILENAME)}`,
      `if (Test-Path -LiteralPath $marker) { try { Write-Output ('REF ' + [IO.File]::ReadAllText($marker).Trim()) } catch { ${fail} } }`,
      // -Filter also matches 8.3 short names; StartsWith preserves the exact prefix.
      `try { $refs = @(Get-ChildItem -LiteralPath $d.FullName -Force -ErrorAction Stop | Where-Object { (-not $_.PSIsContainer) -and $_.Name.StartsWith(${powerShellLiteral(RUNTIME_REF_NODE_PREFIX)}) }) } catch { ${fail} }`,
      `foreach ($f in $refs) { Write-Output ('REF ' + $f.Name.Substring(${RUNTIME_REF_NODE_PREFIX.length})) }`,
      '}',
      `try { $entries = @(Get-ChildItem -LiteralPath $rt -Force -Directory -ErrorAction Stop | Where-Object { $_.Name.StartsWith(${powerShellLiteral(ORCAD_NODE_RUNTIME_DIR_PREFIX)}) -or $_.Name.StartsWith(${powerShellLiteral(`${RUNTIME_STORE_TOMBSTONE_PREFIX}${ORCAD_NODE_RUNTIME_DIR_PREFIX}`)}) }) } catch { ${fail} }`,
      "foreach ($e in $entries) { Write-Output ('ENTRY ' + $e.Name) }",
      `$verified = @($entries | Where-Object { $_.Name.StartsWith(${powerShellLiteral(ORCAD_NODE_RUNTIME_DIR_PREFIX)}) } | ForEach-Object { Get-Item -LiteralPath (Join-Path $_.FullName '.verified') -Force -ErrorAction SilentlyContinue } | Where-Object { $null -ne $_ })`,
      "foreach ($v in @($verified | Sort-Object LastWriteTimeUtc -Descending)) { Write-Output ('VERIFIED ' + $v.Directory.Name) }",
      // Failed process queries must not certify idleness.
      'try {',
      `$held = @(Get-CimInstance -ClassName Win32_Process -Filter "ExecutablePath LIKE '%\\\\${ORCAD_RUNTIMES_DIRNAME}\\\\%'" -Property ExecutablePath -ErrorAction Stop)`,
      "Write-Output 'PROCESS_CHECK cim'",
      "foreach ($p in $held) { if ($p.ExecutablePath) { Write-Output ('HOLD ' + $p.ExecutablePath) } }",
      '} catch {',
      // Standard-user SSH sessions may lack WMI access; Get-Process can still inspect their own images.
      'try {',
      `$held = @(Get-Process -ErrorAction Stop | Where-Object { $_.Path -and $_.Path.IndexOf(${powerShellLiteral(`\\${ORCAD_RUNTIMES_DIRNAME}\\`)}, [StringComparison]::OrdinalIgnoreCase) -ge 0 })`,
      "Write-Output 'PROCESS_CHECK process'",
      "foreach ($p in $held) { Write-Output ('HOLD ' + $p.Path) }",
      '} catch { }',
      '}',
      `Write-Output ${powerShellLiteral(INVENTORY_OK)}`
    ].join('\n')
  )
}

export function windowsSweepStaleRuntimeStagesCommand(
  storeDir: string,
  staleMinutes: number,
  sweptTag: string
): string {
  return powerShellCommand(
    [
      "$ProgressPreference = 'SilentlyContinue'",
      `$cutoff = [DateTime]::UtcNow.AddMinutes(-${staleMinutes})`,
      `$stages = @(Get-ChildItem -LiteralPath ${powerShellLiteral(storeDir)} -Force -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name.StartsWith(${powerShellLiteral(RUNTIME_STORE_STAGE_PREFIX)}) })`,
      'foreach ($s in $stages) {',
      `if ((($s.Attributes -band ${REPARSE}) -ne 0) -or ($s.LastWriteTimeUtc -ge $cutoff)) { continue }`,
      // A listing that cannot answer keeps the stage.
      'try { $recent = @(Get-ChildItem -LiteralPath $s.FullName -Force -Recurse -ErrorAction Stop | Where-Object { $_.LastWriteTimeUtc -ge $cutoff } | Select-Object -First 1) } catch { continue }',
      'if ($recent.Count -gt 0) { continue }',
      `try { Remove-Item -LiteralPath $s.FullName -Recurse -Force -ErrorAction Stop; Write-Output (${powerShellLiteral(`${sweptTag} `)} + $s.Name) } catch { }`,
      '}'
    ].join('\n')
  )
}
