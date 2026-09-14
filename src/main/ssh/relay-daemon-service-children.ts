/**
 * Telling a relay daemon's own service processes apart from the work it holds.
 *
 * The reap gate used to ask `pgrep -P <relay> | grep -c .` and demand zero. But the daemon
 * forks service children of its own — `relay-ai-vault-service.js` is spawned lazily and then
 * never exits — so that count is permanently non-zero on any relay that has touched the AI
 * Vault, whether or not it holds a single PTY. A superseded, disconnected relay holding
 * nothing therefore reported `retained-live-work` forever, its version directory stayed
 * pinned against GC by its own live socket, and the population grew without bound (#13614).
 *
 * The asymmetry below is the whole safety argument, and it follows
 * docs/reference/ssh-execution-boundary.md: *subtracting a child we can positively identify
 * as relay infrastructure is sound; assuming anything about a child we cannot identify is
 * not.* An argv that does not match, an argv `ps` would not print, and a host without
 * `pgrep` all count against the relay and keep it unreapable. Losing sight of a child is
 * never evidence that it holds nothing.
 */
import { RELAY_DAEMON_SERVICE_ENTRY_FILENAMES } from '../../shared/relay-artifacts'
import { shellEscape } from './ssh-connection-utils'

/** Shell variable set to the daemon's direct-child count, or `unknown`. */
export const RELAY_CHILD_COUNT_VAR = 'kids'

/** Shell variable set to the count of children not identified as relay services, or `unknown`. */
export const RELAY_UNRECOGNIZED_CHILD_COUNT_VAR = 'unrecognized_kids'

/**
 * `case` patterns matching a service child's argv. Suffix-anchored on purpose: both entries
 * are forked with no script arguments, so the argv ends at the filename, and the leading `/`
 * requires the absolute path the daemon forks rather than a bare mention of the name. A
 * future arg would stop matching and the relay would go back to being retained — the safe
 * direction to fail in.
 */
function serviceChildArgvPatterns(): string {
  return RELAY_DAEMON_SERVICE_ENTRY_FILENAMES.map(
    (filename) => `*${shellEscape(`/${filename}`)}`
  ).join('|')
}

/**
 * POSIX shell that censuses the direct children of `$pid`, setting `kids` and
 * `unrecognized_kids`. Both stay `unknown` when the host cannot enumerate children at all.
 */
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
    // An unreadable or unrecognised argv lands here, which is what keeps the relay retained.
    `      *) ${RELAY_UNRECOGNIZED_CHILD_COUNT_VAR}=$((${RELAY_UNRECOGNIZED_CHILD_COUNT_VAR}+1)) ;;`,
    '    esac',
    '  done',
    'fi'
  ]
}
