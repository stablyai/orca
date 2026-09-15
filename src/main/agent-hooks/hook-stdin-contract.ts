export type PosixHookEmptyPayloadPolicy = 'exit' | 'empty-object'

// Why: a stripped PATH must not stop a hook from consuming stdin, or the agent
// sees exit 127 and a broken pipe mid-write (#8110). `command -p` resolves from
// the shell's built-in default PATH, so it also survives hosts without /bin/cat
// (NixOS) and ignores a worktree-local `cat` that could capture the payload.
export const POSIX_HOOK_STDIN_READER = '{ command -p cat 2>/dev/null || cat; }'

export const POSIX_HOOK_STDIN_DRAIN_COMMAND = `${POSIX_HOOK_STDIN_READER} >/dev/null 2>&1 || :`

/** Seconds the JSON reader waits for the writer's first byte before giving up.
 *  Comfortably inside Grok's 10s hook timeout, and far enough above process
 *  startup that a loaded or remote host cannot lose a payload that is merely late. */
export const POSIX_HOOK_JSON_STDIN_FIRST_BYTE_TIMEOUT_SECONDS = 5

/** Seconds of silence that end a payload which never parses as JSON (the `cat` shape). */
export const POSIX_HOOK_JSON_STDIN_IDLE_TIMEOUT_SECONDS = 1.5

// Why: Grok SessionStart writes one JSON object and then waits for the hook to
// exit without closing stdin, so reading to EOF deadlocks until Grok's 10s
// timeout. Return as soon as the first complete JSON value has arrived.
//
// Three invariants this script must hold, because the shell chains a second
// reader behind it and a reader that consumed bytes cannot be retried:
//  1. A non-zero exit implies stdin was never read, so the `||` fallback still
//     sees the whole stream. Everything after the imports is therefore guarded.
//  2. Decoding is incremental. A multi-byte character straddling two reads must
//     not raise, or a CJK/emoji payload falls through to `cat` and hangs.
//  3. The payload is emitted unchanged. Re-serialising would rewrite non-ASCII
//     as \uXXXX and reorder keys behind the agent's back.
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
  // raw_decode does not skip leading whitespace, so a padded payload would
  // otherwise never complete and would wait out the idle timeout.
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
  // os.write skips the locale-dependent stdout encoder, which raises under
  // LC_ALL=C for a non-ASCII payload.
  '    data = text.encode("utf-8")',
  '    written = 0',
  '    while written < len(data):',
  '        written += os.write(1, data[written:])',
  'except Exception:',
  '    pass'
].join('\n')

// Why a variable rather than two inline copies: the script is embedded twice in
// the reader chain, and `-c '<600 chars>'` twice is an EDR oversized-command-line
// signal as well as unreadable in the generated hook.
const POSIX_HOOK_JSON_STDIN_PYTHON_VAR = 'orca_hook_json_stdin_py'

export const POSIX_HOOK_JSON_STDIN_PRELUDE: readonly string[] = [
  `${POSIX_HOOK_JSON_STDIN_PYTHON_VAR}='${POSIX_HOOK_JSON_STDIN_PYTHON}'`
]

const jsonStdinInterpreter = (name: string): string =>
  `command -p ${name} -c "$${POSIX_HOOK_JSON_STDIN_PYTHON_VAR}" 2>/dev/null`

// Why: macOS ships /usr/bin/python3 as an Xcode stub that re-resolves the real
// interpreter on every run when it cannot reach its cache under $HOME. A HOME
// that does not exist costs ~6.6s per spawn there, which alone overruns Grok's
// 10s hook budget. Unsetting it brings that back to ~95ms and is what a
// home-less process sees anyway. Safe to mutate: the reader only ever runs
// inside the `payload=$(...)` subshell, so the hook's own HOME is untouched.
const POSIX_HOOK_JSON_STDIN_HOME_GUARD = '{ [ -d "${HOME:-}" ] || unset HOME; }'

// Why `python` too: the script avoids py3-only syntax (verified on 2.7) so a host
// that only ships `python` does not drop straight to the `cat` hang.
export const POSIX_HOOK_JSON_STDIN_READER = `${POSIX_HOOK_JSON_STDIN_HOME_GUARD}; ${jsonStdinInterpreter('python3')} || ${jsonStdinInterpreter('python')} || ${POSIX_HOOK_STDIN_READER}`

/** Optional reader override for an agent whose caller keeps stdin open after the payload.
 *  `prelude` must be emitted before the capture line; keep them together. */
export type PosixHookStdinReader = {
  readonly reader: string
  readonly prelude: readonly string[]
}

export const POSIX_HOOK_JSON_STDIN: PosixHookStdinReader = {
  reader: POSIX_HOOK_JSON_STDIN_READER,
  prelude: POSIX_HOOK_JSON_STDIN_PRELUDE
}

// Why: every POSIX hook must own stdin before any no-op exit; sharing this
// prelude prevents agent templates from inventing different drain semantics.
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

// The Orca context a hook needs before it may own stdin; see the rule below.
const WINDOWS_HOOK_ENVIRONMENT_VARS = [
  'ORCA_AGENT_HOOK_PORT',
  'ORCA_AGENT_HOOK_TOKEN',
  'ORCA_PANE_KEY'
] as const

// Why (#11549): missing Orca context means the hook ran outside an Orca pane, where the caller
// may abandon stdin rather than close it — a read-to-EOF then blocks forever and strands a
// visible window per hook event. The Windows rule: a hook must check the Orca env before it
// owns stdin, and exit without reading when the env is missing — the payload is discarded on
// that path anyway. This applies to .cmd, the copilot .ps1, and the Git Bash kimi .sh alike,
// and to the launchers that own stdin themselves when the managed script is missing.
// POSIX hooks keep capture-first: their callers close stdin, and exiting mid-write there
// surfaces as EPIPE the agent can see (#8110).
export function buildWindowsHookEnvironmentGuardLines(): string[] {
  return WINDOWS_HOOK_ENVIRONMENT_VARS.map((name) => `if "%${name}%"=="" exit /b 0`)
}

/** The same guard in sh, for the Git Bash hooks and launchers that run on Windows.
 *  Default-formed because a static hook precheck (Grok) rejects a bare reference it
 *  cannot resolve. POSIX hosts keep capture-first — this is the Windows rule only. */
export const WINDOWS_GIT_BASH_HOOK_ENVIRONMENT_GUARD = `if ${WINDOWS_HOOK_ENVIRONMENT_VARS.map(
  (name) => `[ -z "\${${name}-}" ]`
).join(' || ')}; then exit 0; fi`

/** The same guard for a PowerShell hook or launcher. Anything that reaches
 *  `[Console]::In.ReadToEnd()` must run this first, or it inherits #11549. */
export const WINDOWS_POWERSHELL_HOOK_ENVIRONMENT_GUARD = `if (${WINDOWS_HOOK_ENVIRONMENT_VARS.map(
  (name) => `-not $env:${name}`
).join(' -or ')}) { exit 0 }`

export function buildWindowsHookStdinDrainEpilogue(): string[] {
  return [`:${WINDOWS_HOOK_STDIN_DRAIN_LABEL}`, WINDOWS_HOOK_STDIN_DRAIN_COMMAND, 'exit /b 0']
}
