import { parseWslUncPath } from '../../shared/wsl-paths'
import type { CodexAppServerConnection } from './codex-app-server-jsonl-client'
import { parseMcpServerNames } from './codex-app-server-protocol'

export async function buildCodexSideQuestThreadConfig(
  connection: CodexAppServerConnection,
  cwd: string
): Promise<Record<string, unknown>> {
  const result = await connection.request('config/read', { cwd })
  const disabledServers = Object.fromEntries(
    parseMcpServerNames(result).map((name) => [name, { enabled: false }])
  )
  // Why: Side Quests are read-only research sessions; inherited app/MCP startup
  // adds seconds and can fail for tools that the session is not allowed to use.
  return {
    mcp_servers: disabledServers,
    features: { apps: false },
    model_reasoning_effort: 'low'
  }
}

export function resolveCodexSideQuestThreadCwd(cwd: string, wslDistro?: string): string {
  if (!wslDistro) {
    return cwd
  }
  // Why: app-server runs inside the selected WSL distro, so its JSON protocol
  // must receive a Linux path even though renderer-owned worktrees use UNC.
  return parseWslUncPath(cwd)?.linuxPath ?? cwd
}
