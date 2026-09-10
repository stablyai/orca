import type { CodexAppServerConnection } from './codex-app-server-connection'

const DISABLED_FEATURES = [
  'apps',
  'code_mode',
  'code_mode_only',
  'context_management',
  'current_time_reminder',
  'deferred_executor',
  'enable_fanout',
  'goals',
  'hooks',
  'image_generation',
  'memories',
  'multi_agent',
  'multi_agent_v2',
  'plugins',
  'request_permissions_tool',
  'shell_snapshot',
  'shell_tool',
  'standalone_web_search',
  'token_budget',
  'tool_suggest',
  'unified_exec',
  'view_image'
]

export async function readCodexNamingConfig(
  connection: Pick<CodexAppServerConnection, 'request'>,
  cwd: string,
  timeoutMs?: number
): Promise<Record<string, unknown>> {
  const response = await connection.request(
    'config/read',
    { cwd, includeLayers: false },
    { timeoutMs }
  )
  if (
    typeof response !== 'object' ||
    response === null ||
    !('config' in response) ||
    typeof response.config !== 'object' ||
    response.config === null
  ) {
    throw new Error('Codex naming requires readable effective configuration')
  }
  const config = response.config as Record<string, unknown>
  const servers = config.mcp_servers
  if (
    servers !== undefined &&
    (typeof servers !== 'object' || servers === null || Array.isArray(servers))
  ) {
    throw new Error('Codex naming requires readable MCP configuration')
  }
  // Read-only permissions still permit invisible reads and MCP tools.
  return {
    ...Object.fromEntries(DISABLED_FEATURES.map((feature) => [`features.${feature}`, false])),
    'orchestrator.skills.enabled': false,
    'skills.include_instructions': false,
    'token_budget.use_history_notes_extension': false,
    'tools.experimental_request_user_input.enabled': false,
    'tools.update_plan.enabled': false,
    web_search: 'disabled',
    mcp_servers: Object.fromEntries(
      Object.keys(servers ?? {}).map((name) => [name, { enabled: false }])
    )
  }
}
