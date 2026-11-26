import { lstat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { AgentSessionMcpServer } from '../../../../shared/agent-session/options/protocol/agent-session-mcp'
import { readNodeFileWithinLimit } from '../../../../shared/file-content/node-bounded-file-reader'
import {
  WORKSPACE_MCP_CONFIG,
  inspectMcpConfigContent
} from '../../../../shared/mcp/configuration/mcp-config'
import { MCP_CONFIG_INSPECTION_MAX_BYTES } from '../../../../shared/mcp/configuration/mcp-config-inspection-limits'
import { agentSessionPinnedLaunchDirectory } from '../../../runtime/agent-session/records/agent-session-record-launch-directory'
import type { ClaudeStructuredSessionAdapterDeps } from '../claude-structured-session-state'
import { supportsClaudeStructuredLocation } from '../launch/claude-structured-location-support'

/** Project declarations only; Claude supplies the effective servers and their capabilities once running. */
export async function readClaudeProjectMcpServers(
  record: AgentSessionRecord,
  resolveWorkspacePath: ClaudeStructuredSessionAdapterDeps['resolveWorkspacePath']
): Promise<AgentSessionMcpServer[]> {
  if (!supportsClaudeStructuredLocation(record.location)) {
    return []
  }
  try {
    const directory =
      agentSessionPinnedLaunchDirectory(record) ??
      (await resolveWorkspacePath?.(record.location.workspaceId))
    if (!directory || !isAbsolute(directory)) {
      return []
    }
    const path = join(directory, WORKSPACE_MCP_CONFIG.relativePath)
    const entry = await lstat(path)
    if (!entry.isFile()) {
      return []
    }
    const { buffer, stats } = await readNodeFileWithinLimit(path, MCP_CONFIG_INSPECTION_MAX_BYTES, {
      regularFileOnly: true
    })
    if (entry.dev !== stats.dev || entry.ino !== stats.ino) {
      return []
    }
    return inspectMcpConfigContent(WORKSPACE_MCP_CONFIG, buffer.toString('utf8'))
      .servers.filter((server) => server.status !== 'invalid')
      .map(({ name }) => ({
        name,
        source: 'project',
        status: 'not-started',
        toolCount: null,
        error: null,
        canReconnect: false,
        canSignIn: false,
        canToggle: false
      }))
  } catch {
    return []
  }
}
