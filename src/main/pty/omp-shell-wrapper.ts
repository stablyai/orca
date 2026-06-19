// Why: OMP 15.x discovers built-in user extensions from ~/.omp/agent, but a
// typed `omp` in an existing terminal still needs Orca's status extension
// passed explicitly. Do not redirect PI_CODING_AGENT_DIR here: that variable
// is OMP's mutable home, so config/auth/session commands must keep the user's
// normal source of truth.

const OMP_SUBCOMMANDS = [
  'acp',
  'agents',
  'auth-broker',
  'auth-gateway',
  'commit',
  'config',
  'grep',
  'grievances',
  'plugin',
  'setup',
  'shell',
  'read',
  'ssh',
  'stats',
  'update',
  'worktree',
  'wt',
  'search',
  'q'
] as const

export function getPosixOmpShellWrapper(): string {
  const subcommands = OMP_SUBCOMMANDS.join('|')
  return `# Why: OMP does not auto-load Orca's managed status extension; wrap only
# interactive launch invocations so subcommands such as \`omp config\` keep
# their normal argv shape.
__orca_omp_is_subcommand() {
  case "\${1:-}" in
    ${subcommands}) return 0 ;;
  esac
  return 1
}
__orca_omp_should_skip_extension() {
  case "\${1:-}" in
    help|--help|-h|--version|-v) return 0 ;;
  esac
  __orca_omp_is_subcommand "\${1:-}"
}
__orca_omp() {
  local __orca_use_extension=1
  __orca_omp_should_skip_extension "\${1:-}" && __orca_use_extension=0
  if [[ $__orca_use_extension -eq 1 && -n "\${ORCA_OMP_STATUS_EXTENSION:-}" && -f "\${ORCA_OMP_STATUS_EXTENSION}" ]]; then
    if [[ "\${1:-}" == "launch" ]]; then
      shift
      command omp launch --extension "\${ORCA_OMP_STATUS_EXTENSION}" "$@"
    else
      command omp --extension "\${ORCA_OMP_STATUS_EXTENSION}" "$@"
    fi
  else
    command omp "$@"
  fi
}
if [[ -n "\${ORCA_OMP_STATUS_EXTENSION:-}" ]]; then
  omp() { __orca_omp "$@"; }
fi
`
}

export function getPowerShellOmpShellWrapper(): string {
  const subcommands = OMP_SUBCOMMANDS.map((value) => `'${value}'`).join(', ')
  return `# Why: OMP does not auto-load Orca's managed status extension; wrap only
# interactive launch invocations so subcommands such as \`omp config\` keep
# their normal argv shape.
function Global:__OrcaOmpIsSubcommand {
    param([string]$Name)
    $subcommands = @(${subcommands})
    return $subcommands -contains $Name
}
function Global:__OrcaOmpShouldSkipExtension {
    param([string]$Name)
    if (@("help", "--help", "-h", "--version", "-v") -contains $Name) { return $true }
    return __OrcaOmpIsSubcommand -Name $Name
}
if ($env:ORCA_OMP_STATUS_EXTENSION) {
    function Global:omp {
        $orcaUseExtension = -not (__OrcaOmpShouldSkipExtension -Name ([string]($args[0])))
        $orcaStatus = 0
        $orcaCommand = Get-Command omp -CommandType Application,ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $orcaCommand) {
            Write-Error "omp executable not found"
            $orcaStatus = 127
        } elseif ($orcaUseExtension -and $env:ORCA_OMP_STATUS_EXTENSION -and
            (Test-Path -LiteralPath $env:ORCA_OMP_STATUS_EXTENSION)) {
            if ($args.Count -gt 0 -and $args[0] -eq "launch") {
                $orcaLaunchArgs = @($args | Select-Object -Skip 1)
                & $orcaCommand.Source launch --extension $env:ORCA_OMP_STATUS_EXTENSION @orcaLaunchArgs
            } else {
                & $orcaCommand.Source --extension $env:ORCA_OMP_STATUS_EXTENSION @args
            }
            $orcaStatus = $LASTEXITCODE
        } else {
            & $orcaCommand.Source @args
            $orcaStatus = $LASTEXITCODE
        }

        $global:LASTEXITCODE = $orcaStatus
    }
}
`
}
