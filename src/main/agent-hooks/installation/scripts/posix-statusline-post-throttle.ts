import { CLAUDE_STATUSLINE_MIN_POST_INTERVAL_SECONDS } from '../../../../shared/agent-usage/rate-limits/claude-statusline-rate-limits'

type PostThrottleOptions = {
  /** Names the stamp file, so each agent throttles its own posts. */
  stampPrefix: string
  /** Leaves the script (`exit 0`) or its function (`return 0`) when a post is not due. */
  skip: 'exit 0' | 'return 0'
  /** Reads the clock from the payload's `total_duration_ms` to avoid a `date` spawn per tick. */
  payloadClock: boolean
}

// Two runs that both read an old stamp may both post; the host keeps the newest reading, so a duplicate is harmless.
// A missing `date` or an unwritable stamp still posts rather than silencing the feed.
export function buildPosixStatusLinePostThrottleLines(options: PostThrottleOptions): string[] {
  const { stampPrefix, skip } = options
  return [
    // The stable leaf UUID excludes path-unsafe and overlong tab IDs.
    'orca_statusline_pane_id=${ORCA_PANE_KEY##*:}',
    // Legacy numeric leaf IDs were tab-local; include a safe tab ID to isolate their stamps.
    'case "$orca_statusline_pane_id" in',
    "  ''|*[!0-9]*) ;;",
    '  *)',
    '    orca_statusline_tab_id=${ORCA_PANE_KEY%:*}',
    '    case "$orca_statusline_tab_id" in',
    "      ''|*[!A-Za-z0-9._-]*) ;;",
    '      *) orca_statusline_pane_id="${orca_statusline_tab_id}_${orca_statusline_pane_id}" ;;',
    '    esac',
    '    ;;',
    'esac',
    `orca_statusline_stamp="\${TMPDIR:-/tmp}/${stampPrefix}-last-\${orca_statusline_pane_id}"`,
    ...(options.payloadClock
      ? [
          // Use the payload clock to avoid per-tick date spawns; fall back if the schema changes.
          'orca_statusline_now=',
          'case "$payload" in',
          '  *\'"total_duration_ms"\'*)',
          '    orca_statusline_duration=${payload#*\'"total_duration_ms"\'}',
          '    orca_statusline_duration=${orca_statusline_duration#*:}',
          '    orca_statusline_duration=${orca_statusline_duration#"${orca_statusline_duration%%[![:space:]]*}"}',
          '    orca_statusline_duration=${orca_statusline_duration%%[!0-9]*}',
          '    case "$orca_statusline_duration" in',
          '      0|[1-9]|[1-9][0-9]*)',
          '        if [ "${#orca_statusline_duration}" -le 15 ]; then',
          '          orca_statusline_now=$((orca_statusline_duration / 1000))',
          '        fi',
          '        ;;',
          '    esac',
          '    ;;',
          'esac',
          'if [ -z "$orca_statusline_now" ]; then',
          '  orca_statusline_now=$(date +%s 2>/dev/null) || orca_statusline_now=',
          'fi'
        ]
      : ['orca_statusline_now=$(date +%s 2>/dev/null) || orca_statusline_now=']),
    // Canonical decimals avoid fatal dash octal errors (008); malformed stamps must fail open.
    'case "$orca_statusline_now" in 0|[1-9]|[1-9][0-9]*) ;; *) orca_statusline_now= ;; esac',
    'if [ -n "$orca_statusline_now" ] && [ -f "$orca_statusline_stamp" ]; then',
    '  orca_statusline_last=',
    '  IFS= read -r orca_statusline_last <"$orca_statusline_stamp" 2>/dev/null || :',
    '  case "$orca_statusline_last" in 0|[1-9]|[1-9][0-9]*) ;; *) orca_statusline_last= ;; esac',
    '  if [ "${#orca_statusline_last}" -gt 15 ]; then orca_statusline_last=; fi',
    '  if [ -n "$orca_statusline_last" ]; then',
    '    orca_statusline_elapsed=$((orca_statusline_now - orca_statusline_last))',
    `    if [ "$orca_statusline_elapsed" -ge 0 ] && [ "$orca_statusline_elapsed" -lt ${CLAUDE_STATUSLINE_MIN_POST_INTERVAL_SECONDS} ]; then`,
    `      ${skip}`,
    '    fi',
    '  fi',
    'fi',
    'if [ -n "$orca_statusline_now" ]; then',
    '  printf \'%s\' "$orca_statusline_now" >"$orca_statusline_stamp" 2>/dev/null || :',
    'fi'
  ]
}
