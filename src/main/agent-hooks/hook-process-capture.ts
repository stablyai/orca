/** Capture before Orca inserts its managed-script shell. */
export const CLAUDE_HOOK_PARENT_CAPTURE =
  'ORCA_HOOK_AGENT_PID="${PPID:-}"; export ORCA_HOOK_AGENT_PID; '

export function buildHookProcessCapture(): string[] {
  return [
    'orca_agent_process=',
    '[ -z "${ORCA_PANE_KEY:-}" ] || case "${ORCA_HOOK_AGENT_PID:-}" in ""|*[!0-9]*) ;; *)',
    '  if [ -r "/proc/$ORCA_HOOK_AGENT_PID/stat" ]; then',
    '    orca_agent_stat=$(cat "/proc/$ORCA_HOOK_AGENT_PID/stat" 2>/dev/null) || orca_agent_stat=',
    '    orca_agent_boot=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null) || orca_agent_boot=',
    '    orca_agent_fields=${orca_agent_stat##*) }',
    '    orca_agent_start=$(printf "%s" "$orca_agent_fields" | awk \'{print $20}\')',
    '    case "$orca_agent_start" in ""|*[!0-9]*) ;; *)',
    '      [ -z "$orca_agent_boot" ] || orca_agent_process=$(printf \'{"pid":%s,"platform":"linux","startTime":"%s:%s"}\' "$ORCA_HOOK_AGENT_PID" "$orca_agent_boot" "$orca_agent_start") ;; esac',
    '  elif [ "$(uname -s 2>/dev/null)" = Darwin ]; then',
    // Match the host probe's timezone when comparing local-time lstart strings.
    '    orca_agent_start=$(TZ=UTC0 LC_ALL=C /bin/ps -p "$ORCA_HOOK_AGENT_PID" -o lstart= 2>/dev/null | sed \'s/^ *//;s/ *$//\')',
    '    [ -z "$orca_agent_start" ] || orca_agent_process=$(printf \'{"pid":%s,"platform":"darwin","startTime":"%s"}\' "$ORCA_HOOK_AGENT_PID" "$orca_agent_start")',
    '  fi ;;',
    'esac'
  ]
}
