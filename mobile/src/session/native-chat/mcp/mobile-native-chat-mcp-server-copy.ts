import type { AgentSessionMcpServer } from '../../../../../src/shared/agent-session/agent-session-mcp'
import type { Translate } from '../../../i18n/mobile-i18n'

export function mobileMcpSourceLabel(source: string, t: Translate): string {
  switch (source) {
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
  switch (server.status) {
    case 'connected':
      return server.toolCount === null
        ? t('chat.mcp.status.connected', 'Connected')
        : server.toolCount === 1
          ? t('chat.mcp.status.connectedTools_one', 'Connected · {{count}} tool', { count: 1 })
          : t('chat.mcp.status.connectedTools_other', 'Connected · {{count}} tools', {
              count: server.toolCount
            })
    case 'pending':
      return t('chat.mcp.status.pending', 'Connecting…')
    case 'needs-auth':
      return server.canSignIn
        ? t('chat.mcp.status.needsAuth', 'Needs sign-in')
        : t('chat.mcp.status.needsAuthAfterSend', 'Needs sign-in. Send a message to sign in here.')
    case 'failed':
      return server.error
        ? t('chat.mcp.status.failedReason', 'Failed: {{error}}', { error: server.error })
        : t('chat.mcp.status.failed', 'Failed')
    case 'disabled':
      return t('chat.mcp.status.disabled', 'Disabled')
  }
}
