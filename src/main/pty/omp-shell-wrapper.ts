// Why: OMP 15.x discovers built-in user extensions from ~/.omp/agent, but a
// typed `omp` in an existing terminal still needs MCode's status extension
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
  return `# Why: OMP does not auto-load MCode's managed status extension; wrap only
# interactive launch invocations so subcommands such as \`omp config\` keep
# their normal argv shape.
__mcode_omp_should_skip_extension() {
  case "\${1:-}" in
    help|--help|-h|--version|-v) return 0 ;;
    ${subcommands}) return 0 ;;
  esac
  return 1
}
__mcode_omp() {
  local __mcode_use_extension=1
  __mcode_omp_should_skip_extension "\${1:-}" && __mcode_use_extension=0
  if [[ $__mcode_use_extension -eq 1 && -n "\${MCODE_OMP_STATUS_EXTENSION:-}" && -f "\${MCODE_OMP_STATUS_EXTENSION}" ]]; then
    if [[ "\${1:-}" == "launch" ]]; then
      shift
      command omp launch --extension "\${MCODE_OMP_STATUS_EXTENSION}" "$@"
    else
      command omp --extension "\${MCODE_OMP_STATUS_EXTENSION}" "$@"
    fi
  else
    command omp "$@"
  fi
}
if [[ -n "\${MCODE_OMP_STATUS_EXTENSION:-}" ]]; then
  omp() { __mcode_omp "$@"; }
fi
`
}

export function getPowerShellOmpShellWrapper(): string {
  const subcommands = OMP_SUBCOMMANDS.map((value) => `'${value}'`).join(', ')
  return `# Why: OMP does not auto-load MCode's managed status extension; wrap only
# interactive launch invocations so subcommands such as \`omp config\` keep
# their normal argv shape.
function Global:__MCodeOmpShouldSkipExtension {
    param([string]$Name)
    $skip = @("help", "--help", "-h", "--version", "-v") + @(${subcommands})
    return $skip -contains $Name
}
if ($env:MCODE_OMP_STATUS_EXTENSION) {
    function Global:omp {
        $mcodeUseExtension = -not (__MCodeOmpShouldSkipExtension -Name ([string]($args[0])))
        $mcodeStatus = 0
        $mcodeCommand = Get-Command omp -CommandType Application,ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $mcodeCommand) {
            Write-Error "omp executable not found"
            $mcodeStatus = 127
        } elseif ($mcodeUseExtension -and $env:MCODE_OMP_STATUS_EXTENSION -and
            (Test-Path -LiteralPath $env:MCODE_OMP_STATUS_EXTENSION)) {
            if ($args.Count -gt 0 -and $args[0] -eq "launch") {
                $mcodeLaunchArgs = @($args | Select-Object -Skip 1)
                & $mcodeCommand.Source launch --extension $env:MCODE_OMP_STATUS_EXTENSION @mcodeLaunchArgs
            } else {
                & $mcodeCommand.Source --extension $env:MCODE_OMP_STATUS_EXTENSION @args
            }
            $mcodeStatus = $LASTEXITCODE
        } else {
            & $mcodeCommand.Source @args
            $mcodeStatus = $LASTEXITCODE
        }

        $global:LASTEXITCODE = $mcodeStatus
    }
}
`
}
