import {
  buildWindowsHookStdinDrainEpilogue,
  WINDOWS_HOOK_STDIN_DRAIN_LABEL,
  WINDOWS_HOOK_STDIN_READER
} from '../agent-hooks/hook-stdin-contract'
import {
  CLAUDE_STATUSLINE_MIN_POST_INTERVAL_SECONDS,
  CLAUDE_STATUSLINE_PATHNAME
} from '../../shared/claude-statusline-rate-limits'

const STATUSLINE_CLEANUP_LABEL = 'orca_statusline_cleanup'
const STATUSLINE_PROBE_LABEL = 'orca_statusline_probe'

// Why: Claude Code pipes `rate_limits` to the statusLine command on every turn; forwarding
// it gives Orca live usage without spending the OAuth usage endpoint's tight budget.
// Emits no stdout so the in-terminal status line stays visually unchanged.
export function getManagedStatusLineScript(target: 'local' | 'posix' = 'local'): string {
  if (target === 'local' && process.platform === 'win32') {
    return [
      '@echo off',
      'setlocal',
      // Why: pane key is static PTY env (the endpoint file never sets it), so it can gate before stdin is consumed.
      `if "%ORCA_PANE_KEY%"=="" goto :${WINDOWS_HOOK_STDIN_DRAIN_LABEL}`,
      // Why: current keys end in a UUID; replacing the legacy delimiter also keeps surviving numeric-pane keys filename-safe.
      'set "ORCA_STATUSLINE_PANE_ID=%ORCA_PANE_KEY:~-36%"',
      'set "ORCA_STATUSLINE_PANE_ID=%ORCA_STATUSLINE_PANE_ID::=_%"',
      // Why: cmd has no builtin stdin capture, so buffer the payload in a per-pane temp file
      // (%RANDOM% collides across same-second cmd spawns) to guard before any curl spawn.
      'set "ORCA_STATUSLINE_PAYLOAD_FILE=%TEMP%\\orca-claude-statusline-%ORCA_STATUSLINE_PANE_ID%.tmp"',
      `${WINDOWS_HOOK_STDIN_READER} >"%ORCA_STATUSLINE_PAYLOAD_FILE%" 2>nul`,
      // Why: an all-builtin seconds-of-day throttle avoids spawning findstr+curl on every streaming tick.
      'set "ORCA_STATUSLINE_STAMP_FILE=%TEMP%\\orca-claude-statusline-last-%ORCA_STATUSLINE_PANE_ID%.tmp"',
      'set "ORCA_STATUSLINE_NOW="',
      'set "ORCA_STATUSLINE_TIME=%TIME: =0%"',
      'for /f "tokens=1-3 delims=:.," %%a in ("%ORCA_STATUSLINE_TIME%") do set /a "ORCA_STATUSLINE_NOW=(1%%a %% 100)*3600+(1%%b %% 100)*60+(1%%c %% 100)" 2>nul',
      'set "ORCA_STATUSLINE_LAST="',
      'set "ORCA_STATUSLINE_ELAPSED="',
      'if exist "%ORCA_STATUSLINE_STAMP_FILE%" set /p ORCA_STATUSLINE_LAST=<"%ORCA_STATUSLINE_STAMP_FILE%"',
      'if defined ORCA_STATUSLINE_LAST for /f "delims=0123456789" %%d in ("%ORCA_STATUSLINE_LAST%") do set "ORCA_STATUSLINE_LAST="',
      'if defined ORCA_STATUSLINE_NOW if defined ORCA_STATUSLINE_LAST set /a "ORCA_STATUSLINE_ELAPSED=ORCA_STATUSLINE_NOW-ORCA_STATUSLINE_LAST" 2>nul',
      `if not defined ORCA_STATUSLINE_ELAPSED goto :${STATUSLINE_PROBE_LABEL}`,
      `if %ORCA_STATUSLINE_ELAPSED% GEQ 0 if %ORCA_STATUSLINE_ELAPSED% LSS ${CLAUDE_STATUSLINE_MIN_POST_INTERVAL_SECONDS} goto :${STATUSLINE_CLEANUP_LABEL}`,
      `:${STATUSLINE_PROBE_LABEL}`,
      // Why: rate_limits appears only for Claude.ai-subscriber sessions after the first API response; the
      // statusline ticks ~3x/sec during streaming, so skip the endpoint call and curl spawn otherwise.
      // Why: \" is the MSVC argv escape — findstr sees the quoted JSON key, so a cwd containing rate_limits can't false-match (POSIX guard parity).
      '"%SystemRoot%\\System32\\findstr.exe" /c:\\"rate_limits\\" "%ORCA_STATUSLINE_PAYLOAD_FILE%" >nul 2>nul',
      `if errorlevel 1 goto :${STATUSLINE_CLEANUP_LABEL}`,
      // Why: call the endpoint file to refresh port/token — a PTY that survived an Orca restart carries stale env; falls through to PTY env if missing.
      'if defined ORCA_AGENT_HOOK_ENDPOINT if exist "%ORCA_AGENT_HOOK_ENDPOINT%" call "%ORCA_AGENT_HOOK_ENDPOINT%" 2>nul',
      `if "%ORCA_AGENT_HOOK_PORT%"=="" goto :${STATUSLINE_CLEANUP_LABEL}`,
      `if "%ORCA_AGENT_HOOK_TOKEN%"=="" goto :${STATUSLINE_CLEANUP_LABEL}`,
      // Why: stamp only when a post is certain, so skipped ticks (no rate_limits, missing port/token) never push the next allowed post out.
      'if defined ORCA_STATUSLINE_NOW (>"%ORCA_STATUSLINE_STAMP_FILE%" echo %ORCA_STATUSLINE_NOW%)',
      // Why: pre-build the field from an always-defined variable so an unset CLAUDE_CONFIG_DIR posts
      // empty (matching POSIX and the null attribution snapshot), never a literal %VAR% token.
      'set "ORCA_STATUSLINE_CONFIG_DIR_FIELD=configDir="',
      'if defined CLAUDE_CONFIG_DIR set "ORCA_STATUSLINE_CONFIG_DIR_FIELD=configDir=%CLAUDE_CONFIG_DIR%"',
      [
        '"%SystemRoot%\\System32\\curl.exe" -sS -X POST',
        `"http://127.0.0.1:%ORCA_AGENT_HOOK_PORT%${CLAUDE_STATUSLINE_PATHNAME}"`,
        '--connect-timeout 0.5 --max-time 1.5',
        '-H "Content-Type: application/x-www-form-urlencoded"',
        '-H "X-Orca-Agent-Hook-Token: %ORCA_AGENT_HOOK_TOKEN%"',
        '--data-urlencode "paneKey=%ORCA_PANE_KEY%"',
        '--data-urlencode "%ORCA_STATUSLINE_CONFIG_DIR_FIELD%"',
        '--data-urlencode "env=%ORCA_AGENT_HOOK_ENV%"',
        '--data-urlencode "version=%ORCA_AGENT_HOOK_VERSION%"',
        '--data-urlencode "payload@%ORCA_STATUSLINE_PAYLOAD_FILE%"',
        '>nul 2>&1'
      ].join(' '),
      `:${STATUSLINE_CLEANUP_LABEL}`,
      'del "%ORCA_STATUSLINE_PAYLOAD_FILE%" >nul 2>nul',
      'exit /b 0',
      ...buildWindowsHookStdinDrainEpilogue(),
      ''
    ].join('\r\n')
  }

  return [
    '#!/bin/sh',
    // Why: this runs on every statusline tick; builtin capture avoids replacing curl churn with cat churn.
    'payload=',
    'while IFS= read -r orca_statusline_line || [ -n "$orca_statusline_line" ]; do',
    '  payload="${payload}${orca_statusline_line}\n"',
    'done',
    'payload=${payload%?}',
    'if [ -z "$payload" ]; then',
    '  exit 0',
    'fi',
    // Why: rate_limits appears only for Claude.ai-subscriber sessions after the first API response; skip the post (and its curl spawn) otherwise.
    'case "$payload" in',
    '  *\'"rate_limits"\'*) ;;',
    '  *) exit 0 ;;',
    'esac',
    'if [ -n "$ORCA_AGENT_HOOK_ENDPOINT" ] && [ -r "$ORCA_AGENT_HOOK_ENDPOINT" ]; then',
    '  . "$ORCA_AGENT_HOOK_ENDPOINT" 2>/dev/null || :',
    'fi',
    'if [ -z "$ORCA_AGENT_HOOK_PORT" ] || [ -z "$ORCA_AGENT_HOOK_TOKEN" ] || [ -z "$ORCA_PANE_KEY" ]; then',
    '  exit 0',
    'fi',
    // Why: the stable leaf UUID avoids path-unsafe and overlong user-supplied tab ids.
    'orca_statusline_pane_id=${ORCA_PANE_KEY##*:}',
    // Why: pre-migration numeric leaf ids were tab-local, so include a safe tab id to avoid cross-pane throttle collisions after upgrade.
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
    'orca_statusline_stamp="${TMPDIR:-/tmp}/orca-claude-statusline-last-${orca_statusline_pane_id}"',
    // Why: the payload clock keeps throttled ticks free of subprocesses; date is only a schema-drift fallback.
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
    'fi',
    // Why: leading zeros read as octal inside $(( )), and a bad constant (008) is FATAL in dash —
    // the script would die before rewriting the stamp, wedging the pane dark. Allow-list canonical
    // decimals so any malformed value fails open to posting instead.
    'case "$orca_statusline_now" in 0|[1-9]|[1-9][0-9]*) ;; *) orca_statusline_now= ;; esac',
    'if [ -n "$orca_statusline_now" ] && [ -f "$orca_statusline_stamp" ]; then',
    '  orca_statusline_last=',
    '  IFS= read -r orca_statusline_last <"$orca_statusline_stamp" 2>/dev/null || :',
    '  case "$orca_statusline_last" in 0|[1-9]|[1-9][0-9]*) ;; *) orca_statusline_last= ;; esac',
    '  if [ "${#orca_statusline_last}" -gt 15 ]; then orca_statusline_last=; fi',
    '  if [ -n "$orca_statusline_last" ]; then',
    '    orca_statusline_elapsed=$((orca_statusline_now - orca_statusline_last))',
    `    if [ "$orca_statusline_elapsed" -ge 0 ] && [ "$orca_statusline_elapsed" -lt ${CLAUDE_STATUSLINE_MIN_POST_INTERVAL_SECONDS} ]; then`,
    '      exit 0',
    '    fi',
    '  fi',
    'fi',
    'if [ -n "$orca_statusline_now" ]; then',
    '  printf \'%s\' "$orca_statusline_now" >"$orca_statusline_stamp" 2>/dev/null || :',
    'fi',
    `printf '%s' "$payload" | curl -sS -X POST "http://127.0.0.1:\${ORCA_AGENT_HOOK_PORT}${CLAUDE_STATUSLINE_PATHNAME}" \\`,
    '  --connect-timeout 0.5 --max-time 1.5 \\',
    '  -H "Content-Type: application/x-www-form-urlencoded" \\',
    '  -H "X-Orca-Agent-Hook-Token: ${ORCA_AGENT_HOOK_TOKEN}" \\',
    '  --data-urlencode "paneKey=${ORCA_PANE_KEY}" \\',
    '  --data-urlencode "configDir=${CLAUDE_CONFIG_DIR}" \\',
    '  --data-urlencode "env=${ORCA_AGENT_HOOK_ENV}" \\',
    '  --data-urlencode "version=${ORCA_AGENT_HOOK_VERSION}" \\',
    '  --data-urlencode "payload@-" >/dev/null 2>&1 || true',
    'exit 0',
    ''
  ].join('\n')
}
