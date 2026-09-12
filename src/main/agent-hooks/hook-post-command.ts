import type { AgentHookSource } from '../../shared/agent-hook-relay'
import { ORCA_HOOK_RAW_JSON_TRANSPORT } from '../../shared/agent-hook-types'

// Why: curl parses --connect-timeout/--max-time with locale-sensitive strtod.
// Comma-decimal locales reject `0.5` before opening a socket, so every hook
// silently falls into the restart spool (#19578). Scoped to LC_NUMERIC so
// spool_json_escape keeps UTF-8 LC_CTYPE for non-ASCII worktree paths.
export function posixCurlCommand(curlCommand = 'curl'): string {
  return `LC_NUMERIC=C ${curlCommand}`
}

export function buildPosixAgentHookPostCommand(
  source: AgentHookSource,
  options: { curlCommand?: string; indent?: string } = {}
): string[] {
  const curlCommand = posixCurlCommand(options.curlCommand ?? 'curl')
  const indent = options.indent ?? '  '
  return [
    `if [ "\${ORCA_AGENT_HOOK_TRANSPORT:-}" = "${ORCA_HOOK_RAW_JSON_TRANSPORT}" ] && command -v base64 >/dev/null 2>&1 && command -v tr >/dev/null 2>&1; then`,
    `  orca_hook_metadata=$(printf '%s\\037%s\\037%s\\037%s\\037%s\\037%s' "$ORCA_PANE_KEY" "$ORCA_TAB_ID" "$ORCA_AGENT_LAUNCH_TOKEN" "$ORCA_WORKTREE_ID" "$ORCA_AGENT_HOOK_ENV" "$ORCA_AGENT_HOOK_VERSION" | base64 | tr -d '\\n') && \\`,
    `  [ -n "$orca_hook_metadata" ] && \\`,
    `  printf '%s' "$payload" | ${curlCommand} -sS -X POST "http://127.0.0.1:\${ORCA_AGENT_HOOK_PORT}/hook/${source}" \\`,
    `  ${indent}--connect-timeout "\${connect_timeout:-0.5}" --max-time "\${max_time:-1.5}" \\`,
    `  ${indent}--noproxy "127.0.0.1" \\`,
    `  ${indent}-H "Content-Type: application/json" \\`,
    `  ${indent}-H "X-Orca-Agent-Hook-Token: \${ORCA_AGENT_HOOK_TOKEN}" \\`,
    `  ${indent}-H "X-Orca-Agent-Hook-Meta-Encoding: base64" \\`,
    `  ${indent}-H "X-Orca-Agent-Hook-Meta: \${orca_hook_metadata}" \\`,
    `  ${indent}--data-binary @-`,
    'else',
    `  printf '%s' "$payload" | ${curlCommand} -sS -X POST "http://127.0.0.1:\${ORCA_AGENT_HOOK_PORT}/hook/${source}" \\`,
    `  ${indent}--connect-timeout "\${connect_timeout:-0.5}" --max-time "\${max_time:-1.5}" \\`,
    `  ${indent}--noproxy "127.0.0.1" \\`,
    `  ${indent}-H "Content-Type: application/x-www-form-urlencoded" \\`,
    `  ${indent}-H "X-Orca-Agent-Hook-Token: \${ORCA_AGENT_HOOK_TOKEN}" \\`,
    `  ${indent}--data-urlencode "paneKey=\${ORCA_PANE_KEY}" \\`,
    `  ${indent}--data-urlencode "tabId=\${ORCA_TAB_ID}" \\`,
    `  ${indent}--data-urlencode "launchToken=\${ORCA_AGENT_LAUNCH_TOKEN}" \\`,
    `  ${indent}--data-urlencode "worktreeId=\${ORCA_WORKTREE_ID}" \\`,
    `  ${indent}--data-urlencode "env=\${ORCA_AGENT_HOOK_ENV}" \\`,
    `  ${indent}--data-urlencode "version=\${ORCA_AGENT_HOOK_VERSION}" \\`,
    `  ${indent}--data-urlencode "payload@-"`,
    'fi'
  ]
}
