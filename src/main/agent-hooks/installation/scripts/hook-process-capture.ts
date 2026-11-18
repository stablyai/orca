/** Capture before Orca inserts its managed-script shell. */
export const HOOK_PARENT_CAPTURE = 'ORCA_HOOK_AGENT_PID="${PPID:-}"; export ORCA_HOOK_AGENT_PID; '

// Uncached, as no builtin tells a reused PID from its old process: Linux reads /proc, macOS runs only ps.
export function buildHookProcessCapture(): string[] {
  return [
    'orca_agent_process= orca_agent_pid="${ORCA_HOOK_AGENT_PID:-}"',
    // Field 2 after the command name is ppid; field 20 is the start time in clock ticks since boot.
    'orca_agent_stat_fields() { orca_agent_ppid=${2-}; orca_agent_start=${20-}; }',
    '[ -z "${ORCA_PANE_KEY:-}" ] || case "$orca_agent_pid" in ""|*[!0-9]*) ;; *)',
    '  if [ -r "/proc/$orca_agent_pid/stat" ]; then',
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
    '  fi ;;',
    'esac',
    // A tmux pane's own server, socket and pane id; only a lookup hint for the host's attachment check.
    'orca_tmux_pane=',
    'case "${TMUX_PANE:-}" in %[0-9]*) [ -z "${TMUX:-}" ] || orca_tmux_pane="$TMUX_PANE ${TMUX%,*,*}" ;; esac'
  ]
}
