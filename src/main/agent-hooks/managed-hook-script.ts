import type { AgentHookSource } from '../../shared/agent-hook-relay'

// Shared builders for the managed agent-hook scripts. Centralizing the
// security-critical steps (reading the endpoint file, and posting to the
// loopback listener) keeps a single audited implementation instead of the same
// shell/batch repeated across every agent's hook service.
//
// Two properties this module guarantees for every generated script:
//   1. The endpoint file is *parsed*, never executed. Earlier scripts sourced
//      it (`. "$file"` / `call "%file%"`), so any shell/batch written into that
//      path ran with the agent's privileges. We only ever copy the four known
//      `ORCA_AGENT_HOOK_*` values out of it.
//   2. The raw payload never appears on the process command line. `ps`/
//      `/proc/<pid>/cmdline` are readable by other same-UID processes, so the
//      payload (the user's prompt and tool output) goes to a private temp file
//      read via `@file`. The token stays an argv header — see the note on
//      `buildPosixSecureCurlPostLines` for why that is deliberate.
// `--noproxy 127.0.0.1` keeps the loopback POST from being redirected through a
// configured `http_proxy`/`ALL_PROXY`, which would send the token and payload
// off-box.

export type PosixEmptyPayloadBehavior = 'exit' | { readonly literal: string }

export type PosixManagedHookScriptOptions = {
  readonly source: AgentHookSource
  /** Lines emitted right after the shebang, before the endpoint is parsed.
   *  Used for agents that must print a JSON response to stdout (Gemini,
   *  Antigravity, Copilot) or bail early (Devin import guard) regardless of
   *  whether the post ultimately fires. */
  readonly preludeLines?: readonly string[]
  /** Extra form fields appended to the curl post, e.g. Antigravity's
   *  `hook_event_name`. `envVar` is read verbatim as `${envVar}`. */
  readonly extraDataFields?: readonly { readonly name: string; readonly envVar: string }[]
  /** What to do when the agent sent no stdin. Default `exit` (skip the post);
   *  Antigravity substitutes `{}` so a status row still appears. */
  readonly emptyPayload?: PosixEmptyPayloadBehavior
}

// Why: `< "$file"` (not `cat "$file" |`) keeps the loop in the current shell so
// the assignments survive it. Each value is copied as a literal — no `eval`, no
// command substitution on the assignment RHS — so `TOKEN=$(rm -rf ~)` in the
// file is stored as that literal string, never executed. The `set ` strip and
// trailing-CR strip tolerate an `endpoint.cmd` (Windows) file that reached a
// POSIX shell via a cross-platform userData copy.
export function buildPosixEndpointParseLines(): string[] {
  return [
    'if [ -n "$ORCA_AGENT_HOOK_ENDPOINT" ] && [ -r "$ORCA_AGENT_HOOK_ENDPOINT" ]; then',
    "  __orca_cr=$(printf '\\r')",
    '  while IFS= read -r __orca_line || [ -n "$__orca_line" ]; do',
    '    __orca_line=${__orca_line%"$__orca_cr"}',
    '    case "$__orca_line" in',
    '      "set "*) __orca_line=${__orca_line#set } ;;',
    '    esac',
    '    case "$__orca_line" in',
    '      ORCA_AGENT_HOOK_PORT=*) ORCA_AGENT_HOOK_PORT=${__orca_line#*=} ;;',
    '      ORCA_AGENT_HOOK_TOKEN=*) ORCA_AGENT_HOOK_TOKEN=${__orca_line#*=} ;;',
    '      ORCA_AGENT_HOOK_ENV=*) ORCA_AGENT_HOOK_ENV=${__orca_line#*=} ;;',
    '      ORCA_AGENT_HOOK_VERSION=*) ORCA_AGENT_HOOK_VERSION=${__orca_line#*=} ;;',
    '    esac',
    '  done < "$ORCA_AGENT_HOOK_ENDPOINT"',
    'fi'
  ]
}

// Why: guards run after the parse so refreshed coordinates are in effect. The
// port is validated as digits-only (defense-in-depth against a malformed
// endpoint file) before it is interpolated into the request URL.
export function buildPosixHookGuardLines(): string[] {
  return [
    'case "$ORCA_AGENT_HOOK_PORT" in',
    '  ""|*[!0-9]*) exit 0 ;;',
    'esac',
    'if [ -z "$ORCA_AGENT_HOOK_TOKEN" ] || [ -z "$ORCA_PANE_KEY" ]; then',
    '  exit 0',
    'fi'
  ]
}

// Why: capture the payload into a private temp file (mktemp is 0600) and post
// it with `--data-urlencode payload@<file>` so the raw prompt never lands on
// argv. This keeps tens-of-KB tool output off the curl command line, which
// avoids EDR command-line-length false positives (the concern #4475 fixed).
// The token stays an argv header: it is a low-value, per-session, loopback-only
// credential already present in the 0600 endpoint file, so its `ps` exposure
// matches the Windows path's documented same-user exposure. Moving it off argv
// on the curl versions we still support would mean routing it through curl's
// config-file loader (the only pre-7.55 stdin-header mechanism), which adds a
// config-directive injection surface out of proportion to what a fake-status
// loopback token is worth. Non-secret identifiers (paneKey/tabId/worktreeId/…)
// stay as argv fields — they are not sensitive and keeping them there avoids
// escaping filesystem paths into the temp file.
export function buildPosixSecureCurlPostLines(options: PosixManagedHookScriptOptions): string[] {
  const { source, extraDataFields = [], emptyPayload = 'exit' } = options
  const emptyLines =
    emptyPayload === 'exit'
      ? ['if [ ! -s "$__orca_payload_file" ]; then', '  exit 0', 'fi']
      : [
          'if [ ! -s "$__orca_payload_file" ]; then',
          `  printf '%s' '${emptyPayload.literal}' > "$__orca_payload_file"`,
          'fi'
        ]
  return [
    // Why: fail open (skip the status post) if the temp file cannot be created,
    // matching the rest of the hook's best-effort behavior. Suppress mktemp's
    // stderr so a failure never leaks into hook output — Claude appends
    // UserPromptSubmit hook stdout to the prompt, and other agents parse stdout.
    '__orca_payload_file=$(mktemp "${TMPDIR:-/tmp}/orca-agent-hook.XXXXXX" 2>/dev/null) || exit 0',
    'trap \'rm -f "$__orca_payload_file"\' EXIT',
    'cat > "$__orca_payload_file"',
    ...emptyLines,
    `curl -sS -X POST "http://127.0.0.1:\${ORCA_AGENT_HOOK_PORT}/hook/${source}" \\`,
    '  --noproxy 127.0.0.1 \\',
    '  --connect-timeout 0.5 --max-time 1.5 \\',
    '  -H "Content-Type: application/x-www-form-urlencoded" \\',
    '  -H "X-Orca-Agent-Hook-Token: ${ORCA_AGENT_HOOK_TOKEN}" \\',
    '  --data-urlencode "paneKey=${ORCA_PANE_KEY}" \\',
    '  --data-urlencode "tabId=${ORCA_TAB_ID}" \\',
    '  --data-urlencode "launchToken=${ORCA_AGENT_LAUNCH_TOKEN}" \\',
    '  --data-urlencode "worktreeId=${ORCA_WORKTREE_ID}" \\',
    '  --data-urlencode "env=${ORCA_AGENT_HOOK_ENV}" \\',
    '  --data-urlencode "version=${ORCA_AGENT_HOOK_VERSION}" \\',
    ...extraDataFields.map((field) => `  --data-urlencode "${field.name}=\${${field.envVar}}" \\`),
    '  --data-urlencode "payload@${__orca_payload_file}" >/dev/null 2>&1 || true'
  ]
}

/** Full POSIX `.sh` managed hook script for a simple agent (shebang, optional
 *  prelude, endpoint parse, guards, secure post). Agents with bespoke recovery
 *  logic (e.g. Command Code) compose the pieces above directly instead. */
export function buildPosixManagedHookScript(options: PosixManagedHookScriptOptions): string {
  return [
    '#!/bin/sh',
    ...(options.preludeLines ?? []),
    ...buildPosixEndpointParseLines(),
    ...buildPosixHookGuardLines(),
    ...buildPosixSecureCurlPostLines(options),
    'exit 0',
    ''
  ].join('\n')
}

// ─── Windows (cmd) endpoint parsing ─────────────────────────────────────────

/** Main-body line that loads endpoint coordinates by *parsing* the file (never
 *  `call`-ing it). Pair with `buildWindowsEndpointSubroutineLines()`, placed
 *  after the script's final `exit /b`. */
export function buildWindowsEndpointLoadLine(): string {
  return 'call :__orcaLoadEndpoint'
}

// Why: `for /f` reads the file line by line and hands each key/value to a
// subroutine that assigns only the four known variables — the file is parsed,
// not executed, so batch written into endpoint.cmd never runs. Both the
// `set `-prefixed (endpoint.cmd) and bare (cross-copied endpoint.env) shapes
// are matched. `%~1`/`%~2` strip the quotes `for /f` leaves on tokens.
// `:__orcaParseEndpointFile` takes an explicit file path so agents that search
// multiple candidate endpoint files (e.g. Command Code) can reuse it.
export function buildWindowsEndpointSubroutineLines(): string[] {
  return [
    ':__orcaLoadEndpoint',
    'if not defined ORCA_AGENT_HOOK_ENDPOINT exit /b 0',
    'call :__orcaParseEndpointFile "%ORCA_AGENT_HOOK_ENDPOINT%"',
    'exit /b 0',
    ':__orcaParseEndpointFile',
    'if not exist "%~1" exit /b 0',
    'for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%~1") do call :__orcaSetEndpoint "%%A" "%%B"',
    'exit /b 0',
    ':__orcaSetEndpoint',
    'set "__orca_k=%~1"',
    'if /i "%__orca_k%"=="set ORCA_AGENT_HOOK_PORT" set "ORCA_AGENT_HOOK_PORT=%~2"',
    'if /i "%__orca_k%"=="ORCA_AGENT_HOOK_PORT" set "ORCA_AGENT_HOOK_PORT=%~2"',
    'if /i "%__orca_k%"=="set ORCA_AGENT_HOOK_TOKEN" set "ORCA_AGENT_HOOK_TOKEN=%~2"',
    'if /i "%__orca_k%"=="ORCA_AGENT_HOOK_TOKEN" set "ORCA_AGENT_HOOK_TOKEN=%~2"',
    'if /i "%__orca_k%"=="set ORCA_AGENT_HOOK_ENV" set "ORCA_AGENT_HOOK_ENV=%~2"',
    'if /i "%__orca_k%"=="ORCA_AGENT_HOOK_ENV" set "ORCA_AGENT_HOOK_ENV=%~2"',
    'if /i "%__orca_k%"=="set ORCA_AGENT_HOOK_VERSION" set "ORCA_AGENT_HOOK_VERSION=%~2"',
    'if /i "%__orca_k%"=="ORCA_AGENT_HOOK_VERSION" set "ORCA_AGENT_HOOK_VERSION=%~2"',
    'exit /b 0'
  ]
}
