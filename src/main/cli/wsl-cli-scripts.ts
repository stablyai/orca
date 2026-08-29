const MANAGED_MARKER = '# Orca managed WSL CLI launcher'
const BRIDGE_MANAGED_MARKER = '# Orca managed WSL CLI PowerShell bridge'

export function buildWslLauncher(
  windowsLauncherPath: string,
  bridgePath = '${XDG_DATA_HOME:-$HOME/.local/share}/orca/orca-wsl-bridge.ps1'
): string {
  const encodedTarget = Buffer.from(windowsLauncherPath, 'utf8').toString('base64')
  return `#!/usr/bin/env bash
set -euo pipefail
${MANAGED_MARKER}
# ORCA_WIN_LAUNCHER_B64=${encodedTarget}
ORCA_WIN_LAUNCHER=${quoteShell(windowsLauncherPath)}
ORCA_BRIDGE_PS1=${quoteShell(bridgePath)}
if command -v powershell.exe >/dev/null 2>&1; then
  ORCA_POWERSHELL=powershell.exe
elif [ -x /mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe ]; then
  ORCA_POWERSHELL=/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe
else
  echo "Orca WSL CLI requires Windows interop and could not find powershell.exe." >&2
  exit 1
fi
# Why: a shell can outlive a deleted worktree; keep explicit CLI selectors and
# help usable, and repair cwd before any WSL interop tool tries to resolve it.
ORCA_WSL_CWD=$(pwd -P 2>/dev/null) || {
  ORCA_WSL_CWD=/
  cd /
}
ORCA_BRIDGE_PS1_WIN=$(wslpath -w "$ORCA_BRIDGE_PS1")
ORCA_WSL_CWD_WIN=$(wslpath -w "$ORCA_WSL_CWD")
exec "$ORCA_POWERSHELL" -NoProfile -ExecutionPolicy Bypass -File "$ORCA_BRIDGE_PS1_WIN" "$ORCA_WIN_LAUNCHER" -WslCwd "$ORCA_WSL_CWD_WIN" "$@"
`
}

export function buildWslBridgeScript(): string {
  return `${BRIDGE_MANAGED_MARKER}
function ConvertTo-NativeCommandLineArgument {
  param([AllowEmptyString()][string]$Value)

  if ($Value.Length -gt 0 -and $Value -notmatch '[\\s"]') {
    return $Value
  }

  $Quoted = [System.Text.StringBuilder]::new()
  [void]$Quoted.Append([char]'"')
  [int]$BackslashCount = 0
  foreach ($Character in $Value.ToCharArray()) {
    if ($Character -eq [char]'\\') {
      $BackslashCount += 1
      continue
    }
    if ($Character -eq [char]'"') {
      [void]$Quoted.Append([char]'\\', $BackslashCount * 2 + 1)
      [void]$Quoted.Append([char]'"')
    } else {
      [void]$Quoted.Append([char]'\\', $BackslashCount)
      [void]$Quoted.Append($Character)
    }
    $BackslashCount = 0
  }
  [void]$Quoted.Append([char]'\\', $BackslashCount * 2)
  [void]$Quoted.Append([char]'"')
  return $Quoted.ToString()
}

$exitCode = 0
try {
  # Why: a param block prefix-binds forwarded flags such as --for in PowerShell 5.1.
  if ($args.Count -lt 1) {
    throw 'Invalid Orca WSL CLI bridge invocation.'
  }
  [string]$OrcaLauncher = $args[0]
  [string]$WslCwd = ''
  [int]$ForwardArgStart = 1
  if ($args.Count -ge 2 -and $args[1] -eq '-WslCwd') {
    if ($args.Count -lt 3) {
      throw 'Invalid Orca WSL CLI bridge invocation.'
    }
    $WslCwd = $args[2]
    $ForwardArgStart = 3
  }
  [string[]]$ForwardArgs = @()
  if ($args.Count -gt $ForwardArgStart) {
    $ForwardArgs = @($args[$ForwardArgStart..($args.Count - 1)])
  }
  if ([string]::IsNullOrEmpty($WslCwd)) {
    Remove-Item Env:ORCA_CLI_CWD -ErrorAction SilentlyContinue
  } else {
    $env:ORCA_CLI_CWD = $WslCwd
  }
  Push-Location -LiteralPath (Split-Path -Parent $OrcaLauncher)
  # Why: Windows PowerShell 5.1 cannot losslessly splat strings to native argv.
  $StartInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $StartInfo.FileName = $OrcaLauncher
  $StartInfo.Arguments = (($ForwardArgs | ForEach-Object {
    ConvertTo-NativeCommandLineArgument $_
  }) -join ' ')
  $StartInfo.UseShellExecute = $false
  $Process = [System.Diagnostics.Process]::Start($StartInfo)
  if ($null -eq $Process) {
    throw 'Unable to start the Orca Windows CLI launcher.'
  }
  $Process.WaitForExit()
  $exitCode = $Process.ExitCode
  $Process.Dispose()
} catch {
  Write-Error $_
  $exitCode = 1
}
exit $exitCode
`
}

export function getBridgePathFromCommandPath(commandPath: string): string {
  // Why: both the current Linux command and the legacy pre-rename command
  // share one WSL bridge under ~/.local/share/orca.
  return `${commandPath.replace(/\/\.local\/bin\/(?:orca|orca-ide)$/, '/.local/share/orca')}/orca-wsl-bridge.ps1`
}

export function buildSafeReplaceGuard(path: string, managedMarker: string): string {
  const quotedPath = quoteShell(path)
  const quotedMarker = quoteShell(managedMarker)
  return [
    `if [ -L ${quotedPath} ]; then`,
    '  echo "__ORCA_CONFLICT__"',
    '  exit 23',
    `elif [ -e ${quotedPath} ] && { [ ! -f ${quotedPath} ] || ! grep -Fq ${quotedMarker} ${quotedPath}; }; then`,
    '  echo "__ORCA_CONFLICT__"',
    '  exit 23',
    'fi'
  ].join('\n')
}

export function buildRegistrationLockPrelude(commandPath: string): string {
  const lockDir = getPosixDirname(getBridgePathFromCommandPath(commandPath))
  // Why: the per-distro queue only serializes one Orca process; flock covers
  // a second install (e.g. stable + nightly) mutating the same distro files.
  return [
    `if command -v flock >/dev/null 2>&1 && mkdir -p ${quoteShell(lockDir)} 2>/dev/null; then`,
    `  exec 9>${quoteShell(`${lockDir}/.orca-wsl-cli.lock`)}`,
    '  flock -x -w 30 9',
    'fi'
  ].join('\n')
}

export function buildManagedLegacyRemoveCommand(quotedLegacyCommandPath: string): string {
  // Why: remove only the Orca-managed pre-rename wrapper; user-owned `orca`
  // commands and symlinks must survive.
  return `if [ ! -L ${quotedLegacyCommandPath} ] && [ -f ${quotedLegacyCommandPath} ] && grep -Fq ${quoteShell(MANAGED_MARKER)} ${quotedLegacyCommandPath}; then rm -f ${quotedLegacyCommandPath}; fi`
}

export function buildSafeRemoveCommand(commandPath: string, legacyCommandPath?: string): string {
  const bridgePath = getBridgePathFromCommandPath(commandPath)
  return [
    // Why -eu not -euo pipefail: this script runs via runWslProcess's `sh -s`,
    // and no pipe here needs pipefail -- dash on Ubuntu 20.04 lacks the option.
    'set -eu',
    buildRegistrationLockPrelude(commandPath),
    buildSafeReplaceGuard(commandPath, MANAGED_MARKER),
    buildSafeReplaceGuard(bridgePath, BRIDGE_MANAGED_MARKER),
    `rm -f ${quoteShell(commandPath)} ${quoteShell(bridgePath)}`,
    // Why: leaving a managed legacy `orca` behind lets startup reconciliation
    // re-adopt it as opt-in proof and silently undo this removal.
    ...(legacyCommandPath ? [buildManagedLegacyRemoveCommand(quoteShell(legacyCommandPath))] : [])
  ].join('\n')
}

export function parseManagedLauncherTarget(content: string): string | null {
  const encoded = content.match(/^# ORCA_WIN_LAUNCHER_B64=([A-Za-z0-9+/=]+)$/m)?.[1]
  if (encoded) {
    try {
      return Buffer.from(encoded, 'base64').toString('utf8')
    } catch {
      return null
    }
  }

  const legacyTarget = content.match(/^ORCA_WIN_LAUNCHER='((?:[^']|'"'"')*)'$/m)?.[1]
  return legacyTarget ? legacyTarget.replaceAll(`'"'"'`, "'") : null
}

export function getPosixDirname(path: string): string {
  return path.slice(0, path.lastIndexOf('/')) || '/'
}

export function getWslLauncherMarker(): string {
  return MANAGED_MARKER
}

export function getWslBridgeMarker(): string {
  return BRIDGE_MANAGED_MARKER
}

export function quoteShell(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}
