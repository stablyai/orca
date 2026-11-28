import type {
  AgentSessionMcpServer,
  AgentSessionMcpSignIn
} from '../../../../../src/shared/agent-session/options/protocol/agent-session-mcp'
import {
  agentSessionMcpServerDisplayName,
  agentSessionMcpShownStatus,
  ORCA_MCP_SOURCE
} from '../../../../../src/shared/agent-session/view/agent-session-mcp-server-presentation'
import type { Translate } from '../../../i18n/mobile-i18n'

export function mobileMcpSourceLabel(source: string, t: Translate): string {
  switch (source) {
    case 'orca':
      return 'Orca'
    case 'claudeai':
      return 'claude.ai'
    case 'project':
      return t('chat.mcp.source.project', 'Project')
    case 'local':
      return t('chat.mcp.source.local', 'Local')
    case 'user':
      return t('chat.mcp.source.user', 'User')
    case 'dynamic':
      return t('chat.mcp.source.session', 'Session')
    case 'plugin':
      return t('chat.mcp.source.plugin', 'Plugin')
    default:
      return source.charAt(0).toUpperCase() + source.slice(1)
  }
}

export function mobileMcpServerStatusLine(server: AgentSessionMcpServer, t: Translate): string {
  // The chat keeps its launch copy of a server Orca changed until the next message restarts it.
  if (server.orcaChange === 'removed') {
    return t('chat.mcp.status.orcaRemoved', 'Removed: restarts on next message')
  }
  if (server.orcaChange === 'changed' && server.status !== 'connected') {
    return t('chat.mcp.status.orcaChanged', 'Changed: restarts on next message')
  }
  switch (server.status) {
    case 'connected':
      // The dot already says connected.
      return server.toolCount === null
        ? t('chat.mcp.status.connected', 'Connected')
        : server.toolCount === 1
          ? t('chat.mcp.status.tools_one', '{{count}} tool', { count: 1 })
          : t('chat.mcp.status.tools_other', '{{count}} tools', { count: server.toolCount })
    case 'pending':
      return t('chat.mcp.status.pending', 'Connecting…')
    case 'needs-auth':
      // Orca signs in to its own servers, from its MCP servers page.
      return server.canSignIn || server.source === ORCA_MCP_SOURCE
        ? t('chat.mcp.status.needsAuth', 'Needs sign-in')
        : t('chat.mcp.status.needsAuthAfterSend', 'Needs sign-in. Send a message to sign in here.')
    case 'failed':
      // Orca's own check found it before the agent started, with the reason desktop gives.
      if (server.orca && !server.error) {
        return server.orca.url === null
          ? t('chat.mcp.status.commandNotFound', 'Command not found')
          : t('chat.mcp.status.unreachable', 'Can’t reach {{host}}', {
              host: urlHost(server.orca.url)
            })
      }
      return server.error
        ? t('chat.mcp.status.failedReason', 'Failed: {{error}}', { error: server.error })
        : t('chat.mcp.status.failed', 'Failed')
    case 'disabled':
      return t('chat.mcp.status.disabled', 'Disabled')
    case 'not-started':
      return t('chat.mcp.status.notStarted', 'Not started')
    case 'unreported':
      return ''
  }
}

export type MobileMcpSummaryPart = { text: string; attention: boolean }

/** The tray header's summary after the title: the sign-in under way, else the non-zero counts. */
export function mobileMcpTraySummary(
  servers: readonly AgentSessionMcpServer[],
  signIn: AgentSessionMcpSignIn | null,
  t: Translate
): MobileMcpSummaryPart[] {
  if (signIn) {
    const server = servers.find((entry) => entry.name === signIn.server)
    const name = server ? agentSessionMcpServerDisplayName(server) : signIn.server
    return [
      {
        text: t('chat.mcp.summary.signingIn', 'signing in to {{name}}', { name }),
        attention: false
      }
    ]
  }
  const count = (status: AgentSessionMcpServer['status']): number =>
    servers.filter((server) => agentSessionMcpShownStatus(server) === status).length
  const connected = count('connected')
  const needsAuth = count('needs-auth')
  const failed = count('failed')
  const parts: MobileMcpSummaryPart[] = []
  if (connected > 0) {
    parts.push({
      text: t('chat.mcp.summary.connected', '{{count}} connected', { count: connected }),
      attention: false
    })
  }
  if (needsAuth > 0) {
    parts.push({
      text:
        needsAuth === 1
          ? t('chat.mcp.summary.needsAuth_one', '{{count}} needs sign-in', { count: 1 })
          : t('chat.mcp.summary.needsAuth_other', '{{count}} need sign-in', { count: needsAuth }),
      attention: true
    })
  }
  if (failed > 0) {
    parts.push({
      text: t('chat.mcp.summary.failed', '{{count}} failed', { count: failed }),
      attention: false
    })
  }
  return parts
}

function urlHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}
