import { AGENT_HOOK_METADATA_CACHE_DIR } from '../../../../shared/agent-hook-listener/transport/agent-hook-spool'
import { buildPosixPaneFileIdLoop } from './hook-post-command'

/** Capture before Orca inserts its managed-script shell. */
export const HOOK_PARENT_CAPTURE = 'ORCA_HOOK_AGENT_PID="${PPID:-}"; export ORCA_HOOK_AGENT_PID; '

const CLAUDE_TOOL_EVENTS = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PostToolBatch']
const TOOL_EVENT_PATTERNS = CLAUDE_TOOL_EVENTS.map((name) => `*'"hook_event_name":"${name}"'*`)

// Safe: each Claude process fires SessionStart first, and every non-tool event rewrites the record.
function buildClaudeIdentityLookupLines(): string[] {
  return [
    '  orca_agent_record= orca_agent_record_line= orca_agent_cached= orca_agent_tool_event=',
    '  orca_agent_session=${payload#*\\"session_id\\":\\"}',
    '  orca_agent_session=${orca_agent_session%%\\"*}',
    '  case "$orca_agent_session" in *[!A-Za-z0-9_-]*) orca_agent_session= ;; esac',
    `  case "$payload" in ${TOOL_EVENT_PATTERNS.join('|')}) orca_agent_tool_event=1 ;; esac`,
    '  if [ -r "${ORCA_AGENT_HOOK_ENDPOINT:-}" ]; then',
    '    orca_agent_record_id=$ORCA_PANE_KEY',
    `    ${buildPosixPaneFileIdLoop('orca_agent_record_id')}`,
    `    orca_agent_record="\${ORCA_AGENT_HOOK_ENDPOINT%/*}/${AGENT_HOOK_METADATA_CACHE_DIR}/agent-$orca_agent_record_id"`,
    '    IFS= read -r orca_agent_record_line 2>/dev/null < "$orca_agent_record"',
    '    if [ -n "$orca_agent_tool_event" ] && [ -n "$orca_agent_session" ]; then',
    '      case "$orca_agent_record_line" in "$orca_agent_pid $orca_agent_session {"*"}") orca_agent_cached=${orca_agent_record_line#* * } ;; esac',
    '    fi',
    '  fi'
  ]
}

// A wrapped caller clears the record: its PID changes with every event.
function buildClaudeIdentityStoreLines(): string[] {
  return [
    '  if [ -n "$orca_agent_record" ] && [ -z "$orca_agent_tool_event" ]; then',
    '    orca_agent_record_next=',
    '    [ "$orca_agent_pid" != "$ORCA_HOOK_AGENT_PID" ] || [ -z "$orca_agent_session" ] || [ -z "$orca_agent_process" ] || orca_agent_record_next="$orca_agent_pid $orca_agent_session $orca_agent_process"',
    '    if [ "$orca_agent_record_next" != "$orca_agent_record_line" ]; then',
    '      orca_agent_record_now=',
    // A hook that stalled past its agent's exit must not overwrite a newer process's record.
    '      IFS= read -r orca_agent_record_now 2>/dev/null < "$orca_agent_record"',
    '      if [ "$orca_agent_record_now" = "$orca_agent_record_line" ]; then',
    '        if [ -z "$orca_agent_record_next" ]; then',
    '          : 2>/dev/null > "$orca_agent_record"',
    '        elif [ -d "${orca_agent_record%/*}" ] || mkdir -m 700 "${orca_agent_record%/*}" 2>/dev/null; then',
    `          printf '%s\\n' "$orca_agent_record_next" 2>/dev/null > "$orca_agent_record.$$" && mv -f "$orca_agent_record.$$" "$orca_agent_record" 2>/dev/null || :`,
    '        fi',
    '      fi',
    '    fi',
    '  fi'
  ]
}

/**
 * Linux reads /proc and macOS runs only ps. With `reuseForClaudeToolEvents`, a Claude tool event
 * takes the identity its pane last recorded for the same PID and session, skipping both ps calls.
 */
export function buildHookProcessCapture(
  options: { reuseForClaudeToolEvents?: boolean } = {}
): string[] {
  const reuse = options.reuseForClaudeToolEvents === true
  return [
    'orca_agent_process= orca_agent_pid="${ORCA_HOOK_AGENT_PID:-}"',
    // Field 2 after the command name is ppid; field 20 is the start time in clock ticks since boot.
    'orca_agent_stat_fields() { orca_agent_ppid=${2-}; orca_agent_start=${20-}; }',
    '[ -z "${ORCA_PANE_KEY:-}" ] || case "$orca_agent_pid" in ""|*[!0-9]*) ;; *)',
    ...(reuse
      ? [
          ...buildClaudeIdentityLookupLines(),
          '  if [ -n "$orca_agent_cached" ]; then',
          '    orca_agent_process=$orca_agent_cached',
          '  elif [ -r "/proc/$orca_agent_pid/stat" ]; then'
        ]
      : ['  if [ -r "/proc/$orca_agent_pid/stat" ]; then']),
    '    orca_agent_stat= orca_agent_line= orca_agent_boot= orca_agent_start= orca_agent_ppid= orca_agent_cmdline=',
    // Read to EOF: a command name may contain a newline, and the strip below takes the last ") ".
    '    while IFS= read -r orca_agent_line || [ -n "$orca_agent_line" ]; do orca_agent_stat="$orca_agent_stat$orca_agent_line "; orca_agent_line=; done 2>/dev/null < "/proc/$orca_agent_pid/stat"',
    '    orca_agent_stat_fields ${orca_agent_stat##*) }',
    // agy runs hooks via `sh -c`; a shell that forks for it leaves $PPID on that short-lived wrapper.
    '    case "${orca_agent_stat%%) *}" in *" (sh"|*" (dash"|*" (bash"|*" (zsh")',
    '      while IFS= read -r orca_agent_line || [ -n "$orca_agent_line" ]; do orca_agent_cmdline="$orca_agent_cmdline$orca_agent_line "; orca_agent_line=; done 2>/dev/null < "/proc/$orca_agent_pid/cmdline"',
    '      case "$orca_agent_cmdline" in *ORCA_HOOK_AGENT_PID=*)',
    '        case "$orca_agent_ppid" in ""|0|1|*[!0-9]*) ;; *)',
    '          if [ -r "/proc/$orca_agent_ppid/stat" ]; then',
    '            orca_agent_pid=$orca_agent_ppid orca_agent_stat= orca_agent_line= orca_agent_start=',
    '            while IFS= read -r orca_agent_line || [ -n "$orca_agent_line" ]; do orca_agent_stat="$orca_agent_stat$orca_agent_line "; orca_agent_line=; done 2>/dev/null < "/proc/$orca_agent_pid/stat"',
    '            orca_agent_stat_fields ${orca_agent_stat##*) }',
    '          fi ;; esac ;; esac ;; esac',
    '    IFS= read -r orca_agent_boot 2>/dev/null < /proc/sys/kernel/random/boot_id',
    '    case "$orca_agent_start" in ""|*[!0-9]*) ;; *)',
    '      [ -z "$orca_agent_boot" ] || orca_agent_process="{\\"pid\\":$orca_agent_pid,\\"platform\\":\\"linux\\",\\"startTime\\":\\"$orca_agent_boot:$orca_agent_start\\"}" ;; esac',
    // Bash sets OSTYPE on macOS; other shells still ask uname.
    '  elif case "${OSTYPE-}" in darwin*) ;; *) [ "$(uname -s 2>/dev/null)" = Darwin ] ;; esac; then',
    '    orca_agent_cmdline=$(exec /bin/ps -p "$orca_agent_pid" -o ppid=,args= 2>/dev/null)',
    '    orca_agent_cmdline=${orca_agent_cmdline#"${orca_agent_cmdline%%[! ]*}"}',
    '    orca_agent_ppid=${orca_agent_cmdline%% *}',
    '    orca_agent_cmdline=${orca_agent_cmdline#* }',
    '    orca_agent_cmdline=${orca_agent_cmdline#"${orca_agent_cmdline%%[! ]*}"}',
    // Match the shell on argv[0] only: an agent's prompt in its args can quote this wrapper.
    '    case "${orca_agent_cmdline%% *}" in sh|*/sh|dash|*/dash|bash|*/bash|zsh|*/zsh)',
    '      case "$orca_agent_cmdline" in *ORCA_HOOK_AGENT_PID=*)',
    '        case "$orca_agent_ppid" in ""|0|1|*[!0-9]*) ;; *) orca_agent_pid=$orca_agent_ppid ;; esac ;; esac ;; esac',
    // Match the host probe's timezone when comparing local-time lstart strings.
    '    orca_agent_start=$(TZ=UTC0 LC_ALL=C exec /bin/ps -p "$orca_agent_pid" -o lstart= 2>/dev/null)',
    '    orca_agent_start=${orca_agent_start#"${orca_agent_start%%[! ]*}"}',
    '    orca_agent_start=${orca_agent_start%"${orca_agent_start##*[! ]}"}',
    '    [ -z "$orca_agent_start" ] || orca_agent_process="{\\"pid\\":$orca_agent_pid,\\"platform\\":\\"darwin\\",\\"startTime\\":\\"$orca_agent_start\\"}"',
    ...(reuse ? ['  fi', ...buildClaudeIdentityStoreLines(), '  ;;'] : ['  fi ;;']),
    'esac',
    // A tmux pane's own server, socket and pane id; only a lookup hint for the host's attachment check.
    'orca_tmux_pane=',
    'case "${TMUX_PANE:-}" in %[0-9]*) [ -z "${TMUX:-}" ] || orca_tmux_pane="$TMUX_PANE ${TMUX%,*,*}" ;; esac'
  ]
}
