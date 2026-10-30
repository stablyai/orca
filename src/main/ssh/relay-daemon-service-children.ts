/** Exclude only positively identified daemon service children from reap decisions. Persistent AI Vault sidecars made raw childCount===0 unreachable (#13614); unknown argv/children still retain the relay (docs/reference/ssh-execution-boundary.md). */
import { RELAY_DAEMON_SERVICE_ENTRY_FILENAMES } from './relay-install-artifacts'
import { quotePosixShell } from '../../shared/shell-argument-quoting'

export const RELAY_CHILD_COUNT_VAR = 'kids'

export const RELAY_UNRECOGNIZED_CHILD_COUNT_VAR = 'unrecognized_kids'

/** Require absolute-path suffix matches with no script args. Future argv changes must fail toward retaining the relay, never misclassifying user work. */
function serviceChildArgvPatterns(): string {
  return RELAY_DAEMON_SERVICE_ENTRY_FILENAMES.map(
    (filename) => `*${quotePosixShell(`/${filename}`)}`
  ).join('|')
}

/** Set both direct/unrecognized child counts to unknown when enumeration fails. */
export function relayDaemonChildCensusShell(): string[] {
  return [
    `${RELAY_CHILD_COUNT_VAR}=unknown`,
    `${RELAY_UNRECOGNIZED_CHILD_COUNT_VAR}=unknown`,
    'if command -v pgrep >/dev/null 2>&1; then',
    `  ${RELAY_CHILD_COUNT_VAR}=0`,
    `  ${RELAY_UNRECOGNIZED_CHILD_COUNT_VAR}=0`,
    '  for kid in $(pgrep -P "$pid" 2>/dev/null); do',
    `    ${RELAY_CHILD_COUNT_VAR}=$((${RELAY_CHILD_COUNT_VAR}+1))`,
    '    kid_args=$(ps -o args= -p "$kid" 2>/dev/null | tr -d "\\n")',
    '    case "$kid_args" in',
    `      ${serviceChildArgvPatterns()}) ;;`,
    // Unreadable or unmatched argv counts as possible work and retains the relay.
    `      *) ${RELAY_UNRECOGNIZED_CHILD_COUNT_VAR}=$((${RELAY_UNRECOGNIZED_CHILD_COUNT_VAR}+1)) ;;`,
    '    esac',
    '  done',
    'fi'
  ]
}
