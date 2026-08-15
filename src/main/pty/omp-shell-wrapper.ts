import {
  ORCA_OMP_FORCE_NEW_SESSION_ENV,
  ORCA_OMP_FRESH_SESSION_DIR_ENV
} from '../../shared/omp-fresh-session-env'

// Why: OMP 15.x discovers built-in user extensions from ~/.omp/agent, but a
// typed `omp` in an existing terminal still needs Orca's status extension
// passed explicitly. Do not redirect PI_CODING_AGENT_DIR here: that variable
// is OMP's mutable home, so config/auth/session commands must keep the user's
// normal source of truth.

const OMP_SUBCOMMANDS = [
  '__complete',
  'acp',
  'agents',
  'auth-broker',
  'auth-gateway',
  'bench',
  'commit',
  'completions',
  'config',
  'dry-balance',
  'gallery',
  'grep',
  'grievances',
  'install',
  'join',
  'models',
  'plugin',
  'read',
  'say',
  'search',
  'setup',
  'shell',
  'ssh',
  'stats',
  'tiny-models',
  'token',
  'ttsr',
  'update',
  'usage',
  'worktree',
  'q',
  'wt'
] as const

export function getPosixOmpShellWrapper(): string {
  const subcommands = OMP_SUBCOMMANDS.join('|')
  return `# Why: OMP does not auto-load Orca's managed status extension; wrap only
# interactive launch invocations so subcommands such as \`omp config\` keep
# their normal argv shape.
__orca_omp_should_skip_extension() {
  case "\${1:-}" in
    help|--help|-h|--version|-v) return 0 ;;
    ${subcommands}) return 0 ;;
  esac
  return 1
}
__orca_omp_has_session_selector() {
  local __orca_arg
  for __orca_arg in "$@"; do
    case "$__orca_arg" in
      --session-dir|--session-dir=*|--resume|--resume=*|-r|--continue|-c|--no-session|--fork|--fork=*) return 0 ;;
    esac
  done
  return 1
}

__orca_omp() {
  local __orca_subcommand="\${1:-}"
  local __orca_use_extension=1
  __orca_omp_should_skip_extension "$__orca_subcommand" && __orca_use_extension=0
  if [[ "\${${ORCA_OMP_FORCE_NEW_SESSION_ENV}:-}" == "1" ]]; then
    unset ${ORCA_OMP_FORCE_NEW_SESSION_ENV}
    if [[ $__orca_use_extension -eq 1 ]] && ! __orca_omp_has_session_selector "$@"; then
      local __orca_session_dir="\${${ORCA_OMP_FRESH_SESSION_DIR_ENV}:-}"
      if [[ -z "$__orca_session_dir" ]]; then
        local __orca_agent_dir="\${ORCA_OMP_SOURCE_AGENT_DIR:-\${PI_CODING_AGENT_DIR:-$HOME/.omp/agent}}"
        __orca_session_dir="$__orca_agent_dir/sessions"
      fi
      if [[ "$__orca_subcommand" == "launch" ]]; then
        shift
        set -- launch --session-dir "$__orca_session_dir" "$@"
      else
        set -- --session-dir "$__orca_session_dir" "$@"
      fi
    fi
  fi
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
function Global:__OrcaOmpShouldSkipExtension {
    param([string]$Name)
    $skip = @("help", "--help", "-h", "--version", "-v") + @(${subcommands})
    return $skip -contains $Name
}
function Global:__OrcaOmpHasSessionSelector {
    param([object[]]$ArgsList)
    foreach ($arg in $ArgsList) {
        $text = [string]$arg
        if ($text -eq "--session-dir" -or $text.StartsWith("--session-dir=") -or
            $text -eq "--resume" -or $text.StartsWith("--resume=") -or
            $text -eq "-r" -or $text -eq "--continue" -or $text -eq "-c" -or
            $text -eq "--no-session" -or $text -eq "--fork" -or $text.StartsWith("--fork=")) {
            return $true
        }
    }
    return $false
}

if ($env:ORCA_OMP_STATUS_EXTENSION) {
    function Global:omp {
        $orcaSubcommand = [string]($args[0])
        $orcaUseExtension = -not (__OrcaOmpShouldSkipExtension -Name $orcaSubcommand)
        $orcaStatus = 0
        $orcaArgs = @($args)
        if ($env:${ORCA_OMP_FORCE_NEW_SESSION_ENV} -eq "1") {
            Remove-Item Env:${ORCA_OMP_FORCE_NEW_SESSION_ENV} -ErrorAction SilentlyContinue
            if ($orcaUseExtension -and -not (__OrcaOmpHasSessionSelector -ArgsList $orcaArgs)) {
                $orcaSessionDir = $env:${ORCA_OMP_FRESH_SESSION_DIR_ENV}
                if (-not $orcaSessionDir) {
                    $orcaAgentDir = if ($env:ORCA_OMP_SOURCE_AGENT_DIR) {
                        $env:ORCA_OMP_SOURCE_AGENT_DIR
                    } elseif ($env:PI_CODING_AGENT_DIR) {
                        $env:PI_CODING_AGENT_DIR
                    } else {
                        Join-Path $HOME ".omp\\agent"
                    }
                    $orcaSessionDir = Join-Path $orcaAgentDir "sessions"
                }
                if ($orcaSubcommand -eq "launch") {
                    $orcaArgs = @("launch", "--session-dir", $orcaSessionDir) + @($orcaArgs | Select-Object -Skip 1)
                } else {
                    $orcaArgs = @("--session-dir", $orcaSessionDir) + $orcaArgs
                }
            }
        }
        $orcaCommand = Get-Command omp -CommandType Application,ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $orcaCommand) {
            Write-Error "omp executable not found"
            $orcaStatus = 127
        } elseif ($orcaUseExtension -and $env:ORCA_OMP_STATUS_EXTENSION -and
            (Test-Path -LiteralPath $env:ORCA_OMP_STATUS_EXTENSION)) {
            if ($orcaArgs.Count -gt 0 -and $orcaArgs[0] -eq "launch") {
                $orcaLaunchArgs = @($orcaArgs | Select-Object -Skip 1)
                & $orcaCommand.Source launch --extension $env:ORCA_OMP_STATUS_EXTENSION @orcaLaunchArgs
            } else {
                & $orcaCommand.Source --extension $env:ORCA_OMP_STATUS_EXTENSION @orcaArgs
            }
            $orcaStatus = $LASTEXITCODE
        } else {
            & $orcaCommand.Source @orcaArgs
            $orcaStatus = $LASTEXITCODE
        }

        $global:LASTEXITCODE = $orcaStatus
    }
}
`
}
