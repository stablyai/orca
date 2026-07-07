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
ORCA_BRIDGE_PS1_WIN=$(wslpath -w "$ORCA_BRIDGE_PS1")
ORCA_WSL_CWD=$(pwd -P)
ORCA_WSL_CWD_WIN=$(wslpath -w "$ORCA_WSL_CWD")
exec "$ORCA_POWERSHELL" -NoProfile -ExecutionPolicy Bypass -File "$ORCA_BRIDGE_PS1_WIN" "$ORCA_WIN_LAUNCHER" "$ORCA_WSL_CWD_WIN" "$@"
`
}

export function buildWslBridgeScript(): string {
  return `${BRIDGE_MANAGED_MARKER}
param(
  [Parameter(Mandatory=$true)]
  [string]$OrcaLauncher,

  [string]$WslCwd,

  [Parameter(ValueFromRemainingArguments=$true)]
  [string[]]$ForwardArgs
)

$previousCliCwdExists = Test-Path Env:ORCA_CLI_CWD
$previousCliCwd = $env:ORCA_CLI_CWD
$exitCode = 0
try {
  if ([string]::IsNullOrEmpty($WslCwd)) {
    Remove-Item Env:ORCA_CLI_CWD -ErrorAction SilentlyContinue
  } else {
    $env:ORCA_CLI_CWD = $WslCwd
  }
  Push-Location -LiteralPath (Split-Path -Parent $OrcaLauncher)
  try {
    & $OrcaLauncher @ForwardArgs
    if ($null -eq $LASTEXITCODE) {
      if (-not $?) {
        $exitCode = 1
      } else {
        $exitCode = 0
      }
    } else {
      $exitCode = $LASTEXITCODE
    }
  } finally {
    Pop-Location
  }
} catch {
  Write-Error $_
  $exitCode = 1
} finally {
  if ($previousCliCwdExists) {
    $env:ORCA_CLI_CWD = $previousCliCwd
  } else {
    Remove-Item Env:ORCA_CLI_CWD -ErrorAction SilentlyContinue
  }
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

export function buildSafeRemoveCommand(commandPath: string): string {
  const bridgePath = getBridgePathFromCommandPath(commandPath)
  return [
    'set -euo pipefail',
    buildSafeReplaceGuard(commandPath, MANAGED_MARKER),
    buildSafeReplaceGuard(bridgePath, BRIDGE_MANAGED_MARKER),
    `rm -f ${quoteShell(commandPath)} ${quoteShell(bridgePath)}`
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
