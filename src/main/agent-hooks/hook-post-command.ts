import type { AgentHookSource } from '../../shared/agent-hook-relay'
import { ORCA_HOOK_RAW_JSON_TRANSPORT } from '../../shared/agent-hook-types'

export function buildPosixAgentHookPostCommand(
  source: AgentHookSource,
  options: { curlCommand?: string; indent?: string } = {}
): string[] {
  const curlCommand = options.curlCommand ?? 'curl'
  const indent = options.indent ?? '  '
  const claude = source === 'claude'
  return [
    `if [ "\${ORCA_AGENT_HOOK_TRANSPORT:-}" = "${ORCA_HOOK_RAW_JSON_TRANSPORT}" ] && command -v base64 >/dev/null 2>&1 && command -v tr >/dev/null 2>&1; then`,
    `  orca_hook_metadata=$(printf '%s\\037%s\\037%s\\037%s\\037%s\\037%s' "$ORCA_PANE_KEY" "$ORCA_TAB_ID" "$ORCA_AGENT_LAUNCH_TOKEN" "$ORCA_WORKTREE_ID" "$ORCA_AGENT_HOOK_ENV" "$ORCA_AGENT_HOOK_VERSION" | base64 | tr -d '\\n') && \\`,
    ...(claude
      ? [
          `  orca_claude_config_dir=$(printf '%s' "\${CLAUDE_CONFIG_DIR:-}" | base64 | tr -d '\\n') && \\`,
          `  orca_claude_user_home=$(printf '%s' "\${HOME:-}" | base64 | tr -d '\\n') && \\`
        ]
      : []),
    `  [ -n "$orca_hook_metadata" ] && \\`,
    `  printf '%s' "$payload" | ${curlCommand} -sS -X POST "http://127.0.0.1:\${ORCA_AGENT_HOOK_PORT}/hook/${source}" \\`,
    `  ${indent}--connect-timeout "\${connect_timeout:-0.5}" --max-time "\${max_time:-1.5}" \\`,
    `  ${indent}--noproxy "127.0.0.1" \\`,
    `  ${indent}-H "Content-Type: application/json" \\`,
    `  ${indent}-H "X-Orca-Agent-Hook-Token: \${ORCA_AGENT_HOOK_TOKEN}" \\`,
    `  ${indent}-H "X-Orca-Agent-Hook-Meta-Encoding: base64" \\`,
    `  ${indent}-H "X-Orca-Agent-Hook-Meta: \${orca_hook_metadata}" \\`,
    `  ${indent}-H "X-Orca-Agent-Process: \${orca_agent_process:-}" \\`,
    ...(claude
      ? [
          `  ${indent}-H "X-Orca-Claude-Config-Kind: \${orca_claude_config_kind}" \\`,
          `  ${indent}-H "X-Orca-Claude-Config-Dir: \${orca_claude_config_dir}" \\`,
          `  ${indent}-H "X-Orca-Claude-User-Home: \${orca_claude_user_home}" \\`
        ]
      : []),
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
    `  ${indent}--data-urlencode "agentProcess=\${orca_agent_process:-}" \\`,
    ...(claude
      ? [
          `  ${indent}--data-urlencode "claudeConfigKind=\${orca_claude_config_kind}" \\`,
          `  ${indent}--data-urlencode "claudeConfigDir=\${CLAUDE_CONFIG_DIR:-}" \\`,
          `  ${indent}--data-urlencode "claudeUserHome=\${HOME:-}" \\`
        ]
      : []),
    `  ${indent}--data-urlencode "payload@-"`,
    'fi'
  ]
}
