import {
  AGENT_HOOK_INBOX_DIR_NAME,
  AGENT_HOOK_INBOX_ENDPOINT_KEY,
  AGENT_HOOK_INBOX_ENDPOINT_VALUE,
  AGENT_HOOK_INBOX_MAX_PAYLOAD_CHARS,
  AGENT_HOOK_INBOX_RECORD_END,
  AGENT_HOOK_INBOX_RECORD_MARKER,
  AGENT_HOOK_INBOX_TOOL_PROGRESS_BACKLOG_LIMIT
} from '../../shared/agent-hook-inbox-record'

/** Bounded retries past record names left by an earlier process that had the same pid. */
const MAX_NAME_ATTEMPTS = 16

export type PosixHookInboxCommitOptions = {
  /** Body fields this agent's POST carries beyond the pane identity, as shell expansions. */
  extraFields?: readonly { key: string; value: string }[]
  /** Variable holding an event name the provider passes out-of-band instead of in the payload. */
  eventNameVar?: string
}

/**
 * Defines `orca_hook_commit`, which durably hands the captured `$payload` to the execution host by
 * writing one record into its hook inbox. Scripts call it right after capture and exit on success;
 * on failure (no inbox advertised, not writable, oversized) they fall through to the POST.
 *
 * Why commit instead of POST: the agent kills a hook at its deadline, and a loaded host can start
 * the hook late. The record is written by one `printf` — no curl, no network, no wait on Orca — so
 * the event is durable as soon as the shell has read it, and Orca applies it whenever it drains.
 */
export function buildPosixHookInboxCommitLines(
  source: string,
  options: PosixHookInboxCommitOptions = {}
): string[] {
  const fields = [
    ['paneKey', '${ORCA_PANE_KEY}'],
    ['tabId', '${ORCA_TAB_ID:-}'],
    ['worktreeId', '${ORCA_WORKTREE_ID:-}'],
    ['env', '$orca_inbox_env'],
    ['version', '$orca_inbox_version'],
    ['launchToken', '${ORCA_AGENT_LAUNCH_TOKEN:-}'],
    ...(options.extraFields ?? []).map(({ key, value }) => [key, value])
  ]
  // Why values are printf ARGS: a `%` or `\` in a path or payload must reach the file verbatim.
  const format = [
    '%s',
    AGENT_HOOK_INBOX_RECORD_MARKER,
    `source=${source}`,
    ...fields.map(([key]) => `${key}=%s`),
    AGENT_HOOK_INBOX_RECORD_END
  ].join('\\n')
  const args = ['"$payload"', ...fields.map(([, value]) => `"${value}"`)].join(' ')
  const toolProgressCase = options.eventNameVar
    ? `  case "\${${options.eventNameVar}:-}" in PreToolUse|PostToolUse|PostToolUseFailure) return 0 ;; esac`
    : '  case "$payload" in *\'"PreToolUse"\'*|*\'"PostToolUse"\'*|*\'"PostToolUseFailure"\'*) return 0 ;; esac'
  const endpointLine = `${AGENT_HOOK_INBOX_ENDPOINT_KEY}=${AGENT_HOOK_INBOX_ENDPOINT_VALUE}`
  return [
    'orca_hook_commit() {',
    '  [ -n "${ORCA_PANE_KEY:-}" ] && [ -r "${ORCA_AGENT_HOOK_ENDPOINT:-}" ] || return 1',
    // Why read the file, not the env: only the live endpoint file proves its Orca drains the inbox;
    // an inherited variable or an older Orca's file must keep the POST.
    '  orca_inbox_enabled= orca_inbox_env=${ORCA_AGENT_HOOK_ENV:-} orca_inbox_version=${ORCA_AGENT_HOOK_VERSION:-}',
    '  while IFS= read -r orca_inbox_line || [ -n "$orca_inbox_line" ]; do',
    '    case "$orca_inbox_line" in',
    `      '${endpointLine}') orca_inbox_enabled=1 ;;`,
    '      ORCA_AGENT_HOOK_ENV=*) orca_inbox_env=${orca_inbox_line#*=} ;;',
    '      ORCA_AGENT_HOOK_VERSION=*) orca_inbox_version=${orca_inbox_line#*=} ;;',
    '    esac',
    '  done < "$ORCA_AGENT_HOOK_ENDPOINT"',
    '  [ -n "$orca_inbox_enabled" ] || return 1',
    `  orca_inbox=\${ORCA_AGENT_HOOK_ENDPOINT%/*}/${AGENT_HOOK_INBOX_DIR_NAME}`,
    `  [ -d "$orca_inbox" ] && [ "\${#payload}" -le ${AGENT_HOOK_INBOX_MAX_PAYLOAD_CHARS} ] || return 1`,
    // Why a backlog bound: the endpoint file outlives its Orca, so with Orca closed nothing drains.
    // Positional parameters are local to this function, so the glob count clobbers nothing.
    '  set -- "$orca_inbox"/*.rec',
    '  [ -e "$1" ] || set --',
    `  if [ "$#" -ge ${AGENT_HOOK_INBOX_TOOL_PROGRESS_BACKLOG_LIMIT} ]; then`,
    `  ${toolProgressCase}`,
    '  fi',
    '  orca_inbox_seq=0',
    `  while [ "$orca_inbox_seq" -lt ${MAX_NAME_ATTEMPTS} ]; do`,
    '    orca_inbox_record="$orca_inbox/$$.$orca_inbox_seq.rec"',
    '    if [ ! -e "$orca_inbox_record" ]; then',
    // Why noclobber: the record must be a file this hook created, never one it truncated.
    '      set -C',
    `      printf '${format}\\n' ${args} 2>/dev/null >"$orca_inbox_record"`,
    '      orca_inbox_status=$?',
    '      set +C',
    '      return "$orca_inbox_status"',
    '    fi',
    '    orca_inbox_seq=$((orca_inbox_seq + 1))',
    '  done',
    '  return 1',
    '}'
  ]
}
