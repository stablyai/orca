import { buildPosixStatusLinePostThrottleLines } from '../agent-hooks/installation/scripts/posix-statusline-post-throttle'
import { posixCurlCommand } from '../agent-hooks/installation/scripts/hook-post-command'
import { ANTIGRAVITY_STATUSLINE_PATHNAME } from '../../shared/agent-usage/rate-limits/antigravity-statusline-quota'
import { quotePosixShell } from '../../shared/shell/launch/shell-argument-quoting'

const DEFAULT_FOOTER_LEFT = '? for shortcuts'

// Quote and brace characters live in variables so the generated shell needs no backslash escapes.
const JSON_FIELD_LINES = [
  "orca_agy_q='\"'",
  "orca_agy_rb='}'",
  'orca_agy_json_field() {',
  '  case "$1" in *"$orca_agy_q$2$orca_agy_q"*) ;; *) return 1 ;; esac',
  '  orca_agy_rest=${1#*"$orca_agy_q$2$orca_agy_q"}',
  '  orca_agy_rest=${orca_agy_rest#"${orca_agy_rest%%[![:space:]]*}"}',
  '  case "$orca_agy_rest" in \':\'*) ;; *) return 1 ;; esac',
  '  orca_agy_rest=${orca_agy_rest#:}',
  '  orca_agy_rest=${orca_agy_rest#"${orca_agy_rest%%[![:space:]]*}"}',
  '}',
  'orca_agy_json_string() {',
  '  orca_agy_json_field "$1" "$2" || return 1',
  '  case "$orca_agy_rest" in "$orca_agy_q"*) ;; *) return 1 ;; esac',
  '  orca_agy_rest=${orca_agy_rest#"$orca_agy_q"}',
  '  orca_agy_value=${orca_agy_rest%%"$orca_agy_q"*}',
  // A backslash means an escape sequence this parser does not decode.
  "  case \"$orca_agy_value\" in ''|*'\\'*) return 1 ;; esac",
  '}',
  'orca_agy_json_number() {',
  '  orca_agy_json_field "$1" "$2" || return 1',
  '  orca_agy_value=${orca_agy_rest%%[!0-9]*}',
  '  case "$orca_agy_value" in \'\'|*[!0-9]*|0?*) return 1 ;; esac',
  '}'
]

// agy erases its own footer when the command prints nothing, so an empty slot must redraw it.
// Width is counted in ASCII characters; wide or combining model names would misalign the row.
const DEFAULT_FOOTER_LINES = [
  'orca_agy_add() {',
  '  if [ -n "$orca_agy_right" ]; then',
  '    orca_agy_right="$orca_agy_right · $1"',
  '    orca_agy_rlen=$((orca_agy_rlen + ${#1} + 3))',
  '  else',
  '    orca_agy_right=$1',
  '    orca_agy_rlen=${#1}',
  '  fi',
  '}',
  'orca_agy_footer() {',
  `  orca_agy_left='${DEFAULT_FOOTER_LEFT}'`,
  "  orca_agy_right=''",
  '  orca_agy_rlen=0',
  '  if orca_agy_json_string "$payload" cycle_mode; then orca_agy_add "$orca_agy_value"; fi',
  '  if orca_agy_json_field "$payload" model; then',
  '    case "$orca_agy_rest" in \'{\'*)',
  '      orca_agy_model=${orca_agy_rest%%"$orca_agy_rb"*}',
  '      if orca_agy_json_string "$orca_agy_model" display_name; then',
  "        orca_agy_name=${orca_agy_value% '('*}",
  '        orca_agy_add "$orca_agy_name"',
  '      fi',
  '      if orca_agy_json_string "$orca_agy_model" effort; then orca_agy_add "$orca_agy_value"; fi',
  '      ;;',
  '    esac',
  '  fi',
  '  if [ -z "$orca_agy_right" ] || ! orca_agy_json_number "$payload" terminal_width; then',
  '    printf \'%s\\n\' "$orca_agy_left"',
  '    return 0',
  '  fi',
  '  orca_agy_pad=$((orca_agy_value - ${#orca_agy_left} - orca_agy_rlen))',
  '  [ "$orca_agy_pad" -ge 1 ] || orca_agy_pad=1',
  "  orca_agy_gap=' '",
  '  while [ "${#orca_agy_gap}" -lt "$orca_agy_pad" ]; do orca_agy_gap="$orca_agy_gap "; done',
  '  printf \'%s%s%s\\n\' "$orca_agy_left" "$orca_agy_gap" "$orca_agy_right"',
  '}'
]

const POST_QUOTA_LINES = [
  'orca_agy_post_quota() {',
  '  case "$payload" in *\'"quota"\'*) ;; *) return 0 ;; esac',
  '  if [ -n "$ORCA_AGENT_HOOK_ENDPOINT" ] && [ -r "$ORCA_AGENT_HOOK_ENDPOINT" ]; then',
  '    . "$ORCA_AGENT_HOOK_ENDPOINT" 2>/dev/null || :',
  '  fi',
  '  if [ -z "$ORCA_AGENT_HOOK_PORT" ] || [ -z "$ORCA_AGENT_HOOK_TOKEN" ] || [ -z "$ORCA_PANE_KEY" ]; then',
  '    return 0',
  '  fi',
  ...buildPosixStatusLinePostThrottleLines({
    stampPrefix: 'orca-antigravity-statusline',
    skip: 'return 0',
    payloadClock: false
  }),
  // Detached stdio lets agy's pipe close without waiting on the post.
  `  { printf '%s' "$payload" | ${posixCurlCommand()} -sS -X POST "http://127.0.0.1:\${ORCA_AGENT_HOOK_PORT}${ANTIGRAVITY_STATUSLINE_PATHNAME}" \\`,
  '    --connect-timeout 0.5 --max-time 1.5 --noproxy "127.0.0.1" \\',
  '    -H "Content-Type: application/x-www-form-urlencoded" \\',
  '    -H "X-Orca-Agent-Hook-Token: ${ORCA_AGENT_HOOK_TOKEN}" \\',
  '    --data-urlencode "paneKey=${ORCA_PANE_KEY}" \\',
  '    --data-urlencode "env=${ORCA_AGENT_HOOK_ENV}" \\',
  '    --data-urlencode "version=${ORCA_AGENT_HOOK_VERSION}" \\',
  '    --data-urlencode "payload@-"; } </dev/null >/dev/null 2>&1 &',
  '  return 0',
  '}'
]

// Reads stdin exactly: the last partial line, if any, lands in the variable `read` leaves on EOF.
const READ_PAYLOAD_LINES = [
  'payload=',
  'while IFS= read -r orca_agy_line; do',
  '  payload="${payload}${orca_agy_line}\n"',
  'done',
  'payload="${payload}${orca_agy_line}"'
]

// POSIX only: agy's status line runs through `sh -c`; Windows, WSL and SSH hosts are not supported.
export function getAntigravityStatusLineScript(originalCommand: string | null): string {
  const original = originalCommand?.trim() ? originalCommand : null
  const body = original
    ? [
        `orca_agy_original=${quotePosixShell(original)}`,
        ...READ_PAYLOAD_LINES,
        'orca_agy_post_quota',
        // A pipe keeps the user's command's stdin the kind agy gave it, with the same bytes.
        'printf \'%s\' "$payload" | sh -c "$orca_agy_original"'
      ]
    : [...READ_PAYLOAD_LINES, 'orca_agy_post_quota', 'orca_agy_footer', 'exit 0']
  return [
    '#!/bin/sh',
    ...JSON_FIELD_LINES,
    ...(original ? [] : DEFAULT_FOOTER_LINES),
    ...POST_QUOTA_LINES,
    ...body,
    ''
  ].join('\n')
}
