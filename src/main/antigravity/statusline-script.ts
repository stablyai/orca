import { posixCurlCommand } from '../agent-hooks/installation/scripts/hook-post-command'
import { CLAUDE_STATUSLINE_MIN_POST_INTERVAL_SECONDS } from '../../shared/agent-usage/rate-limits/claude-statusline-rate-limits'
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
const DEFAULT_FOOTER_LINES = [
  'orca_agy_footer() {',
  `  orca_agy_left='${DEFAULT_FOOTER_LEFT}'`,
  '  orca_agy_json_field "$payload" model || { printf \'%s\\n\' "$orca_agy_left"; return 0; }',
  '  case "$orca_agy_rest" in \'{\'*) ;; *) printf \'%s\\n\' "$orca_agy_left"; return 0 ;; esac',
  '  orca_agy_model=${orca_agy_rest%%"$orca_agy_rb"*}',
  '  orca_agy_json_string "$payload" cycle_mode || { printf \'%s\\n\' "$orca_agy_left"; return 0; }',
  '  orca_agy_cycle=$orca_agy_value',
  '  orca_agy_json_string "$orca_agy_model" display_name || { printf \'%s\\n\' "$orca_agy_left"; return 0; }',
  "  orca_agy_name=${orca_agy_value% '('*}",
  '  orca_agy_json_string "$orca_agy_model" effort || { printf \'%s\\n\' "$orca_agy_left"; return 0; }',
  '  orca_agy_effort=$orca_agy_value',
  '  orca_agy_json_number "$payload" terminal_width || { printf \'%s\\n\' "$orca_agy_left"; return 0; }',
  // Counts characters by hand: sh may measure bytes, and the separators are multibyte.
  '  orca_agy_pad=$((orca_agy_value - ${#orca_agy_left} - ${#orca_agy_cycle} - ${#orca_agy_name} - ${#orca_agy_effort} - 6))',
  '  [ "$orca_agy_pad" -ge 1 ] || orca_agy_pad=1',
  "  orca_agy_gap=' '",
  '  while [ "${#orca_agy_gap}" -lt "$orca_agy_pad" ]; do orca_agy_gap="$orca_agy_gap "; done',
  '  printf \'%s%s%s · %s · %s\\n\' "$orca_agy_left" "$orca_agy_gap" "$orca_agy_cycle" "$orca_agy_name" "$orca_agy_effort"',
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
  '  orca_agy_pane=${ORCA_PANE_KEY##*:}',
  '  case "$orca_agy_pane" in \'\'|*[!A-Za-z0-9._-]*) return 0 ;; esac',
  '  orca_agy_stamp="${TMPDIR:-/tmp}/orca-antigravity-statusline-last-${orca_agy_pane}"',
  '  orca_agy_now=$(date +%s 2>/dev/null) || orca_agy_now=',
  // Canonical decimals avoid fatal dash octal errors; a malformed stamp must fail open.
  '  case "$orca_agy_now" in 0|[1-9]|[1-9][0-9]*) ;; *) orca_agy_now= ;; esac',
  '  if [ -n "$orca_agy_now" ]; then',
  '    if [ -f "$orca_agy_stamp" ]; then',
  '      orca_agy_last=',
  '      IFS= read -r orca_agy_last <"$orca_agy_stamp" 2>/dev/null || :',
  '      case "$orca_agy_last" in 0|[1-9]|[1-9][0-9]*) ;; *) orca_agy_last= ;; esac',
  '      if [ "${#orca_agy_last}" -gt 15 ]; then orca_agy_last=; fi',
  '      if [ -n "$orca_agy_last" ]; then',
  '        orca_agy_elapsed=$((orca_agy_now - orca_agy_last))',
  `        if [ "$orca_agy_elapsed" -ge 0 ] && [ "$orca_agy_elapsed" -lt ${CLAUDE_STATUSLINE_MIN_POST_INTERVAL_SECONDS} ]; then`,
  '          return 0',
  '        fi',
  '      fi',
  '    fi',
  '    printf \'%s\' "$orca_agy_now" >"$orca_agy_stamp" 2>/dev/null || :',
  '  fi',
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

const READ_PAYLOAD_LINES = [
  'payload=',
  'while IFS= read -r orca_agy_line || [ -n "$orca_agy_line" ]; do',
  '  payload="${payload}${orca_agy_line}\n"',
  'done',
  'payload=${payload%?}'
]

// POSIX only: agy's status line runs through `sh -c`; Windows, WSL and SSH hosts are not supported.
export function getAntigravityStatusLineScript(originalCommand: string | null): string {
  const original = originalCommand?.trim() ? originalCommand : null
  const body = original
    ? [
        `orca_agy_original=${quotePosixShell(original)}`,
        'orca_agy_tmp=$(mktemp "${TMPDIR:-/tmp}/orca-antigravity-statusline.XXXXXX" 2>/dev/null) || exec sh -c "$orca_agy_original"',
        'trap \'rm -f "$orca_agy_tmp"\' EXIT',
        "trap 'exit 1' HUP INT TERM",
        // A file keeps the user's command's stdin byte-identical to what agy sent.
        'cat >"$orca_agy_tmp"',
        'exec <"$orca_agy_tmp"',
        ...READ_PAYLOAD_LINES,
        'orca_agy_post_quota',
        'sh -c "$orca_agy_original" <"$orca_agy_tmp"',
        'orca_agy_status=$?',
        'exit "$orca_agy_status"'
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
