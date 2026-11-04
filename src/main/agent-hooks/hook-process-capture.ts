/** Capture before Orca inserts its managed-script shell. */
export const HOOK_PARENT_CAPTURE = 'ORCA_HOOK_AGENT_PID="${PPID:-}"; export ORCA_HOOK_AGENT_PID; '

// Runs on every hook event: Linux reads /proc with builtins and macOS starts only `ps`.
// It is not cached, as no shell builtin can tell a reused PID from the process that had it.
export function buildHookProcessCapture(): string[] {
  return [
    'orca_agent_process=',
    // Field 20 after the command name is the start time in clock ticks since boot.
    'orca_agent_start_ticks() { orca_agent_start=${20-}; }',
    '[ -z "${ORCA_PANE_KEY:-}" ] || case "${ORCA_HOOK_AGENT_PID:-}" in ""|*[!0-9]*) ;; *)',
    '  if [ -r "/proc/$ORCA_HOOK_AGENT_PID/stat" ]; then',
    '    orca_agent_stat= orca_agent_boot= orca_agent_start=',
    '    IFS= read -r orca_agent_stat 2>/dev/null < "/proc/$ORCA_HOOK_AGENT_PID/stat"',
    '    IFS= read -r orca_agent_boot 2>/dev/null < /proc/sys/kernel/random/boot_id',
    '    orca_agent_start_ticks ${orca_agent_stat##*) }',
    '    case "$orca_agent_start" in ""|*[!0-9]*) ;; *)',
    '      [ -z "$orca_agent_boot" ] || orca_agent_process="{\\"pid\\":$ORCA_HOOK_AGENT_PID,\\"platform\\":\\"linux\\",\\"startTime\\":\\"$orca_agent_boot:$orca_agent_start\\"}" ;; esac',
    // Bash sets OSTYPE on macOS; other shells still ask uname.
    '  elif case "${OSTYPE-}" in darwin*) ;; *) [ "$(uname -s 2>/dev/null)" = Darwin ] ;; esac; then',
    // Match the host probe's timezone when comparing local-time lstart strings.
    '    orca_agent_start=$(TZ=UTC0 LC_ALL=C exec /bin/ps -p "$ORCA_HOOK_AGENT_PID" -o lstart= 2>/dev/null)',
    '    orca_agent_start=${orca_agent_start#"${orca_agent_start%%[! ]*}"}',
    '    orca_agent_start=${orca_agent_start%"${orca_agent_start##*[! ]}"}',
    '    [ -z "$orca_agent_start" ] || orca_agent_process="{\\"pid\\":$ORCA_HOOK_AGENT_PID,\\"platform\\":\\"darwin\\",\\"startTime\\":\\"$orca_agent_start\\"}"',
    '  fi ;;',
    'esac',
    // A tmux pane's own server, socket and pane id; only a lookup hint for the host's attachment check.
    'orca_tmux_pane=',
    'case "${TMUX_PANE:-}" in %[0-9]*) [ -z "${TMUX:-}" ] || orca_tmux_pane="$TMUX_PANE ${TMUX%,*,*}" ;; esac'
  ]
}
