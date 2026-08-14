export function resolveCodexShellLaunchPreflightCommand(options: {
  hooksEnabled: boolean
  isPackaged: boolean
  isWsl?: boolean
  managedHomePath: string | null
}): string | null {
  if (!options.hooksEnabled || options.isWsl || !options.managedHomePath) {
    return null
  }
  return options.isPackaged ? 'orca' : 'orca-dev'
}

export function getPosixCodexShellLaunchPreflight(): string {
  return `# Why: a typed alias expands inside the shell, after pane launch prep.
__orca_codex_binary="$(command -v codex 2>/dev/null || :)"
if [[ -n "\${ORCA_CODEX_LAUNCH_PREFLIGHT:-}" && -n "\${__orca_codex_binary:-}" && -x "\${__orca_codex_binary}" ]]; then
  codex() {
    "\${ORCA_CODEX_LAUNCH_PREFLIGHT}" agent hooks prepare-codex >/dev/null 2>&1 || :
    command codex "$@"
  }
fi
unset __orca_codex_binary
`
}

export function getFishCodexShellLaunchPreflight(): string {
  return `if test -n "$ORCA_CODEX_LAUNCH_PREFLIGHT"; and test (type -t codex 2>/dev/null) = file
  function codex
    command "$ORCA_CODEX_LAUNCH_PREFLIGHT" agent hooks prepare-codex >/dev/null 2>&1; or true
    command codex $argv
  end
end`
}

export function getPowerShellCodexShellLaunchPreflight(): string {
  return `$orcaCodexCommand = Get-Command codex -ErrorAction SilentlyContinue | Select-Object -First 1
if ($env:ORCA_CODEX_LAUNCH_PREFLIGHT -and $orcaCodexCommand -and
    $orcaCodexCommand.CommandType -in @("Application", "ExternalScript")) {
    function Global:codex {
        try {
            & $env:ORCA_CODEX_LAUNCH_PREFLIGHT agent hooks prepare-codex *> $null
        } catch {
        }
        $orcaCodexExecutable = Get-Command codex -CommandType Application,ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $orcaCodexExecutable) {
            Write-Error "codex executable not found"
            $global:LASTEXITCODE = 127
            return
        }
        & $orcaCodexExecutable.Source @args
        $global:LASTEXITCODE = $LASTEXITCODE
    }
}
Remove-Variable orcaCodexCommand -ErrorAction SilentlyContinue`
}
