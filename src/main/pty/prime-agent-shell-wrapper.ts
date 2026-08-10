import { wslHookRelayEndpointFilePath } from '../../shared/wsl-hook-relay-contract'

const PRIME_AGENT_SUBCOMMANDS = [
  'agents',
  'config',
  'doctor',
  'help',
  'list',
  'model',
  'package',
  'rename',
  'schedule',
  'send',
  'session',
  'shutdown',
  'status',
  'stop',
  'update'
] as const

export function getPosixPrimeAgentShellWrapper(): string {
  const subcommands = PRIME_AGENT_SUBCOMMANDS.join('|')
  const guestEndpointPath = wslHookRelayEndpointFilePath('${HOME%/}', '${ORCA_WSL_HOOK_INSTANCE}')
  return `# Why: WSL cannot install into Prime's guest-owned config root from the
# Windows host, so pass Orca's status extension only to interactive launches.
if [[ -n "\${ORCA_PRIME_AGENT_STATUS_EXTENSION:-}" ]]; then
  __orca_prime_agent_should_skip_extension() {
    if [[ "\${1:-}" == "--daemon-socket" && ( "\${3:-}" == "stop" || "\${3:-}" == "rename" ) ]]; then
      return 0
    fi
    if [[ "\${1:-}" == --daemon-socket=* && ( "\${2:-}" == "stop" || "\${2:-}" == "rename" ) ]]; then
      return 0
    fi
    case "\${1:-}" in
      help|--help|-h|--version|-v|--extension|--extension=*) return 0 ;;
      ${subcommands}) return 0 ;;
    esac
    return 1
  }
  __orca_prime_agent_has_explicit_extension() {
    local __orca_arg
    for __orca_arg in "$@"; do
      case "$__orca_arg" in
        --extension|--extension=*) return 0 ;;
      esac
    done
    return 1
  }
  __orca_prime_agent() {
    if [[ "\${1:-}" == "attach" && ( -z "\${2:-}" || "\${2:-}" == -* ) ]]; then
      command prime-agent "$@"
      return
    fi
    if ! __orca_prime_agent_should_skip_extension "$@" && ! __orca_prime_agent_has_explicit_extension "$@" && [[ -f "\${ORCA_PRIME_AGENT_STATUS_EXTENSION}" ]]; then
      local __orca_guest_endpoint="${guestEndpointPath}"
      if [[ -n "\${HOME:-}" && -n "\${ORCA_WSL_HOOK_INSTANCE:-}" ]]; then
        local ORCA_AGENT_HOOK_ENDPOINT="$__orca_guest_endpoint"
        export ORCA_AGENT_HOOK_ENDPOINT
      fi
      if [[ "\${1:-}" == "attach" && -n "\${2:-}" && "\${2:-}" != -* ]]; then
        local __orca_attach_agent="$2"
        shift 2
        command prime-agent attach "$__orca_attach_agent" --extension "\${ORCA_PRIME_AGENT_STATUS_EXTENSION}" "$@"
      else
        command prime-agent --extension "\${ORCA_PRIME_AGENT_STATUS_EXTENSION}" "$@"
      fi
    else
      command prime-agent "$@"
    fi
  }
  prime-agent() { __orca_prime_agent "$@"; }
fi
`
}
