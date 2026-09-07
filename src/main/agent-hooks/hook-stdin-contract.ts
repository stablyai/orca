export type PosixHookEmptyPayloadPolicy = 'exit' | 'empty-object'

// Why: a stripped PATH must not stop a hook from consuming stdin, or the agent
// sees exit 127 and a broken pipe mid-write (#8110). `command -p` resolves from
// the shell's built-in default PATH, so it also survives hosts without /bin/cat
// (NixOS) and ignores a worktree-local `cat` that could capture the payload.
export const POSIX_HOOK_STDIN_READER = '{ command -p cat 2>/dev/null || cat; }'
export const POSIX_HOOK_STDIN_DRAIN_COMMAND = `${POSIX_HOOK_STDIN_READER} >/dev/null 2>&1 || :`

// Why: every POSIX hook must own stdin before any no-op exit; sharing this
// prelude prevents agent templates from inventing different drain semantics.
export function buildPosixHookPayloadCapture(
  emptyPayloadPolicy: PosixHookEmptyPayloadPolicy = 'exit'
): string[] {
  const emptyPayloadLines =
    emptyPayloadPolicy === 'empty-object' ? ["  payload='{}'"] : ['  exit 0']
  return [
    `payload=$(${POSIX_HOOK_STDIN_READER})`,
    'if [ -z "$payload" ]; then',
    ...emptyPayloadLines,
    'fi'
  ]
}

/** Shell-side durable fallback shared by every POSIX managed hook.
 *  `eventNameVar` is for providers that send the event name out-of-band rather than in the
 *  payload JSON; without it both the progress filter and replay would miss the event name. */
export function buildPosixHookSpoolLines(source: string, eventNameVar?: string): string[] {
  // Why: the event name must be a printf ARG, not inlined in the single-quoted format,
  // where a command substitution would be emitted literally.
  const eventFormat = eventNameVar ? '"hookEventName":"%s",' : ''
  const eventArg = eventNameVar ? ` "$(spool_json_escape "\${${eventNameVar}:-}")"` : ''
  const spoolRecordLine = "  { printf '\\n{".concat(
    eventFormat,
    '"paneKey":"%s","tabId":"%s","worktreeId":"%s","env":"%s","version":"%s","launchToken":"%s","source":"%s","receivedAt":%s,"payload":%s}\\n\'',
    eventArg,
    ' "$(spool_json_escape "${ORCA_PANE_KEY:-}")" "$(spool_json_escape "${ORCA_TAB_ID:-}")" "$(spool_json_escape "${ORCA_WORKTREE_ID:-}")" "$(spool_json_escape "${ORCA_AGENT_HOOK_ENV:-}")" "$(spool_json_escape "${ORCA_AGENT_HOOK_VERSION:-}")" "$(spool_json_escape "${ORCA_AGENT_LAUNCH_TOKEN:-}")" "$(spool_json_escape "',
    source,
    '")" "$spool_now" "$payload"; } >> "$spool_file" 2>/dev/null || :'
  )
  return [
    'spool_hook_event() {',
    eventNameVar
      ? `  case "\${${eventNameVar}:-}" in PreToolUse|PostToolUse|PostToolUseFailure) return 0 ;; esac`
      : '  case "$payload" in *\'"PreToolUse"\'*|*\'"PostToolUse"\'*|*\'"PostToolUseFailure"\'*) return 0 ;; esac',
    '  [ -n "${ORCA_AGENT_HOOK_ENDPOINT:-}" ] || return 0',
    // Why: an endpoint can linger in a parent shell after leaving Orca; without a pane key
    // the record is un-attributable and would accumulate as pane-unknown.jsonl.
    '  [ -n "${ORCA_PANE_KEY:-}" ] || return 0',
    // Why: a stale env var must not create a spool tree for an Orca that is not installed here.
    '  [ -r "$ORCA_AGENT_HOOK_ENDPOINT" ] || return 0',
    '  spool_base=${ORCA_AGENT_HOOK_ENDPOINT%/*}',
    '  spool_dir="$spool_base/spool"',
    '  mkdir -p "$spool_dir" 2>/dev/null || return 0',
    '  chmod 700 "$spool_dir" 2>/dev/null || :',
    "  spool_id=$(printf %s \"${ORCA_PANE_KEY:-unknown}\" | tail -c 36 | tr '/:' '__')",
    '  spool_file="$spool_dir/pane-$spool_id.jsonl"',
    '  if [ -f "$spool_file" ] && find "$spool_file" -mtime +7 -print -quit 2>/dev/null | grep -q .; then : > "$spool_file"; fi',
    '  [ -f "$spool_file" ] || : > "$spool_file"',
    '  spool_size=$(wc -c < "$spool_file" 2>/dev/null || printf 0)',
    '  [ "$spool_size" -lt 5242880 ] || return 0',
    '  spool_now=$(date +%s 2>/dev/null || printf 0)',
    '  spool_now=$((spool_now * 1000))',
    '  spool_json_escape() { printf %s "$1" | sed \'s/\\\\/\\\\\\\\/g; s/"/\\\\"/g; s/[[:cntrl:]]/ /g\'; }',
    spoolRecordLine,
    '  chmod 600 "$spool_file" 2>/dev/null || :',
    '}'
  ]
}

export const WINDOWS_HOOK_STDIN_DRAIN_LABEL = 'orca_agent_hook_drain_stdin'
// Why: qualify the stdin reader because Windows searches the worktree for
// executables before PATH and hook payloads must not reach repo-local code.
export const WINDOWS_HOOK_STDIN_READER = '"%SystemRoot%\\System32\\more.com"'
export const WINDOWS_HOOK_STDIN_DRAIN_COMMAND = `${WINDOWS_HOOK_STDIN_READER} >nul 2>nul`

// Why (#11549): missing Orca context means the hook ran outside an Orca pane, where the caller
// may abandon stdin rather than close it — a read-to-EOF then blocks forever and strands a
// visible window per hook event. The Windows rule: a hook must check the Orca env before it
// owns stdin, and exit without reading when the env is missing — the payload is discarded on
// that path anyway. This applies to .cmd, the copilot .ps1, and the Git Bash kimi .sh alike.
// POSIX hooks keep capture-first: their callers close stdin, and exiting mid-write there
// surfaces as EPIPE the agent can see (#8110).
export function buildWindowsHookEnvironmentGuardLines(): string[] {
  return [
    'if "%ORCA_AGENT_HOOK_PORT%"=="" exit /b 0',
    'if "%ORCA_AGENT_HOOK_TOKEN%"=="" exit /b 0',
    'if "%ORCA_PANE_KEY%"=="" exit /b 0'
  ]
}

export function buildWindowsHookStdinDrainEpilogue(): string[] {
  return [`:${WINDOWS_HOOK_STDIN_DRAIN_LABEL}`, WINDOWS_HOOK_STDIN_DRAIN_COMMAND, 'exit /b 0']
}
