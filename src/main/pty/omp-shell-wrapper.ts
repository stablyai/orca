// Why: OMP 15.x discovers built-in user extensions from ~/.omp/agent, not
// PI_CODING_AGENT_DIR/extensions. Orca's status extension must be
// passed explicitly when users type `omp` in an existing terminal.

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
  return `# Why: OMP does not auto-load Orca's PTY overlay extensions; wrap only
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
  local __orca_prev_pi="\${PI_CODING_AGENT_DIR-}"
  local __orca_had_pi=0
  [[ -n "\${PI_CODING_AGENT_DIR+x}" ]] && __orca_had_pi=1
  [[ -n "\${ORCA_OMP_CODING_AGENT_DIR:-}" ]] && export PI_CODING_AGENT_DIR="\${ORCA_OMP_CODING_AGENT_DIR}"

  local __orca_status=0
  if [[ -n "\${ORCA_OMP_STATUS_EXTENSION:-}" && -f "\${ORCA_OMP_STATUS_EXTENSION}" ]] && ! __orca_omp_should_skip_extension "\${1:-}"; then
    if [[ "\${1:-}" == "launch" ]]; then
      shift
      command omp launch --extension "\${ORCA_OMP_STATUS_EXTENSION}" "$@"
    else
      command omp --extension "\${ORCA_OMP_STATUS_EXTENSION}" "$@"
    fi
  else
    command omp "$@"
  fi
  __orca_status=$?

  if [[ $__orca_had_pi -eq 1 ]]; then
    export PI_CODING_AGENT_DIR="$__orca_prev_pi"
  else
    unset PI_CODING_AGENT_DIR
  fi
  return $__orca_status
}
if [[ -n "\${ORCA_OMP_CODING_AGENT_DIR:-}" || -n "\${ORCA_OMP_STATUS_EXTENSION:-}" ]]; then
  omp() { __orca_omp "$@"; }
fi
`
}

export function getPowerShellOmpShellWrapper(): string {
  const subcommands = OMP_SUBCOMMANDS.map((value) => `'${value}'`).join(', ')
  return `# Why: OMP does not auto-load Orca's PTY overlay extensions; wrap only
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
if ($env:ORCA_OMP_CODING_AGENT_DIR -or $env:ORCA_OMP_STATUS_EXTENSION) {
    function Global:omp {
        $orcaPrevPi = $env:PI_CODING_AGENT_DIR
        $orcaHadPi = Test-Path Env:PI_CODING_AGENT_DIR
        if ($env:ORCA_OMP_CODING_AGENT_DIR) {
            $env:PI_CODING_AGENT_DIR = $env:ORCA_OMP_CODING_AGENT_DIR
        }

        $orcaStatus = 0
        $orcaCommand = Get-Command omp -CommandType Application,ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $orcaCommand) {
            Write-Error "omp executable not found"
            $orcaStatus = 127
        } elseif ($env:ORCA_OMP_STATUS_EXTENSION -and
            (Test-Path -LiteralPath $env:ORCA_OMP_STATUS_EXTENSION) -and
            -not (__OrcaOmpShouldSkipExtension -Name ([string]($args[0])))) {
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

        if ($orcaHadPi) {
            $env:PI_CODING_AGENT_DIR = $orcaPrevPi
        } else {
            Remove-Item Env:PI_CODING_AGENT_DIR -ErrorAction SilentlyContinue
        }
        $global:LASTEXITCODE = $orcaStatus
    }
}
`
}
