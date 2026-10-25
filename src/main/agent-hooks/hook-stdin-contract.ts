export type PosixHookEmptyPayloadPolicy = 'exit' | 'empty-object'

// Use the default PATH to drain stdin on stripped-PATH/NixOS hosts and avoid repo-local cat.
export const POSIX_HOOK_STDIN_READER = '{ command -p cat 2>/dev/null || cat; }'
export const POSIX_HOOK_STDIN_DRAIN_COMMAND = `${POSIX_HOOK_STDIN_READER} >/dev/null 2>&1 || :`

/** Leave startup headroom within Grok's 10-second hook budget. */
export const POSIX_HOOK_JSON_STDIN_FIRST_BYTE_TIMEOUT_SECONDS = 5
/** Stop stalled input that never forms complete JSON. */
export const POSIX_HOOK_JSON_STDIN_IDLE_TIMEOUT_SECONDS = 1.5

// Grok keeps stdin open: return complete JSON unchanged, decode incrementally, and fail only before reading.
const POSIX_HOOK_JSON_STDIN_PYTHON = [
  'import codecs, json, os, select',
  'text = ""',
  'try:',
  '    decoder = codecs.getincrementaldecoder("utf-8")("replace")',
  `    timeout = ${POSIX_HOOK_JSON_STDIN_FIRST_BYTE_TIMEOUT_SECONDS}.0`,
  '    while 1:',
  '        if not select.select([0], [], [], timeout)[0]:',
  '            text += decoder.decode(b"", True)',
  '            break',
  '        chunk = os.read(0, 65536)',
  '        if not chunk:',
  '            text += decoder.decode(b"", True)',
  '            break',
  `        timeout = ${POSIX_HOOK_JSON_STDIN_IDLE_TIMEOUT_SECONDS}`,
  '        text += decoder.decode(chunk)',
  // raw_decode rejects leading whitespace.
  '        value = text.lstrip()',
  '        if not value:',
  '            continue',
  '        try:',
  '            end = json.JSONDecoder().raw_decode(value)[1]',
  '        except ValueError:',
  '            continue',
  '        text = value[:end]',
  '        break',
  'except Exception:',
  '    pass',
  'try:',
  // Write bytes to bypass the locale-dependent stdout encoder.
  '    data = text.encode("utf-8")',
  '    written = 0',
  '    while written < len(data):',
  '        written += os.write(1, data[written:])',
  'except Exception:',
  '    pass'
].join('\n')

// Embed the script once to avoid oversized command lines flagged by EDR.
const POSIX_HOOK_JSON_STDIN_PYTHON_VAR = 'orca_hook_json_stdin_py'
export const POSIX_HOOK_JSON_STDIN_PRELUDE: readonly string[] = [
  `${POSIX_HOOK_JSON_STDIN_PYTHON_VAR}='${POSIX_HOOK_JSON_STDIN_PYTHON}'`
]

const jsonStdinInterpreter = (name: string): string =>
  `command -p ${name} -c "$${POSIX_HOOK_JSON_STDIN_PYTHON_VAR}" 2>/dev/null`

// An invalid HOME stalls macOS's Python stub; unset it only inside the payload-capture subshell.
const POSIX_HOOK_JSON_STDIN_HOME_GUARD = '{ [ -d "${HOME:-}" ] || unset HOME; }'

// Python 2.7 compatibility avoids falling back to a hanging cat on older hosts.
export const POSIX_HOOK_JSON_STDIN_READER = `${POSIX_HOOK_JSON_STDIN_HOME_GUARD}; ${jsonStdinInterpreter('python3')} || ${jsonStdinInterpreter('python')} || ${POSIX_HOOK_STDIN_READER}`

/** Emit prelude before capture when overriding the reader for callers that keep stdin open. */
export type PosixHookStdinReader = {
  readonly reader: string
  readonly prelude: readonly string[]
}

export const POSIX_HOOK_JSON_STDIN: PosixHookStdinReader = {
  reader: POSIX_HOOK_JSON_STDIN_READER,
  prelude: POSIX_HOOK_JSON_STDIN_PRELUDE
}

// POSIX hooks must drain stdin before any no-op exit to prevent agent-side broken pipes.
export function buildPosixHookPayloadCapture(
  emptyPayloadPolicy: PosixHookEmptyPayloadPolicy = 'exit',
  stdinReader: PosixHookStdinReader = { reader: POSIX_HOOK_STDIN_READER, prelude: [] }
): string[] {
  const emptyPayloadLines =
    emptyPayloadPolicy === 'empty-object' ? ["  payload='{}'"] : ['  exit 0']
  return [
    ...stdinReader.prelude,
    `payload=$(${stdinReader.reader})`,
    'if [ -z "$payload" ]; then',
    ...emptyPayloadLines,
    'fi'
  ]
}

/** Providers with out-of-band event names need eventNameVar for spool filtering and replay. */
export function buildPosixHookSpoolLines(source: string, eventNameVar?: string): string[] {
  // Pass substitutions as printf arguments; single-quoted formats would emit them literally.
  const eventFormat = eventNameVar ? '"hookEventName":"%s",' : ''
  const eventArg = eventNameVar ? ` "$(spool_json_escape "\${${eventNameVar}:-}")"` : ''
  const spoolRecordLine = "  { printf '\\n{".concat(
    eventFormat,
    '"paneKey":"%s","tabId":"%s","worktreeId":"%s","env":"%s","version":"%s","launchToken":"%s","source":"%s","receivedAt":%s,"agentProcess":"%s","payload":%s}\\n\'',
    eventArg,
    ' "$(spool_json_escape "${ORCA_PANE_KEY:-}")" "$(spool_json_escape "${ORCA_TAB_ID:-}")" "$(spool_json_escape "${ORCA_WORKTREE_ID:-}")" "$(spool_json_escape "${ORCA_AGENT_HOOK_ENV:-}")" "$(spool_json_escape "${ORCA_AGENT_HOOK_VERSION:-}")" "$(spool_json_escape "${ORCA_AGENT_LAUNCH_TOKEN:-}")" "$(spool_json_escape "',
    source,
    '")" "$spool_now" "$(spool_json_escape "${orca_agent_process:-}")" "$payload"; } >> "$spool_file" 2>/dev/null || :'
  )
  return [
    'spool_hook_event() {',
    eventNameVar
      ? `  case "\${${eventNameVar}:-}" in PreToolUse|PostToolUse|PostToolUseFailure) return 0 ;; esac`
      : '  case "$payload" in *\'"PreToolUse"\'*|*\'"PostToolUse"\'*|*\'"PostToolUseFailure"\'*) return 0 ;; esac',
    '  [ -n "${ORCA_AGENT_HOOK_ENDPOINT:-}" ] || return 0',
    // Stale endpoint variables outside Orca must not accumulate unattributed spool records.
    '  [ -n "${ORCA_PANE_KEY:-}" ] || return 0',
    // A stale variable must not create spool state for an absent Orca installation.
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
// Windows searches the worktree before PATH; never give hook payloads to a repo-local executable.
export const WINDOWS_HOOK_STDIN_READER = '"%SystemRoot%\\System32\\more.com"'
export const WINDOWS_HOOK_STDIN_DRAIN_COMMAND = `${WINDOWS_HOOK_STDIN_READER} >nul 2>nul`

const WINDOWS_HOOK_ENVIRONMENT_VARS = [
  'ORCA_AGENT_HOOK_PORT',
  'ORCA_AGENT_HOOK_TOKEN',
  'ORCA_PANE_KEY'
] as const

// Windows callers may leave stdin open outside Orca: guard first; POSIX must capture first to avoid EPIPE.
export function buildWindowsHookEnvironmentGuardLines(): string[] {
  return WINDOWS_HOOK_ENVIRONMENT_VARS.map((name) => `if "%${name}%"=="" exit /b 0`)
}

/** Git Bash on Windows needs default-form variables to pass Grok's static precheck. */
export const WINDOWS_GIT_BASH_HOOK_ENVIRONMENT_GUARD = `if ${WINDOWS_HOOK_ENVIRONMENT_VARS.map(
  (name) => `[ -z "\${${name}-}" ]`
).join(' || ')}; then exit 0; fi`

/** Check Orca context before any PowerShell ReadToEnd to avoid hanging on abandoned stdin. */
export const WINDOWS_POWERSHELL_HOOK_ENVIRONMENT_GUARD = `if (${WINDOWS_HOOK_ENVIRONMENT_VARS.map(
  (name) => `-not $env:${name}`
).join(' -or ')}) { exit 0 }`

export function buildWindowsHookStdinDrainEpilogue(): string[] {
  return [`:${WINDOWS_HOOK_STDIN_DRAIN_LABEL}`, WINDOWS_HOOK_STDIN_DRAIN_COMMAND, 'exit /b 0']
}
