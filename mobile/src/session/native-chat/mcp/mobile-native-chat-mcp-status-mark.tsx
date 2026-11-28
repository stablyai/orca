import { View } from 'react-native'
import type { AgentSessionMcpServer } from '../../../../../src/shared/agent-session/options/protocol/agent-session-mcp'
import { useThemedStyles } from '../../../theme/themed-styles'
import { mcpPanelStylesSheet as stylesSheet } from './mobile-native-chat-mcp-panel-styles'

/** A `/mcp` tray row's status dot. */
export function McpStatusMark({ status }: { status: AgentSessionMcpServer['status'] }) {
  const styles = useThemedStyles(stylesSheet)
  switch (status) {
    case 'connected':
      return <View style={[styles.dot, styles.dotConnected]} />
    case 'needs-auth':
      return <View style={[styles.dot, styles.dotNeedsAuth]} />
    case 'failed':
      return <View style={[styles.dot, styles.dotFailed]} />
    case 'disabled':
    case 'not-started':
    case 'unreported':
      return <View style={[styles.dot, styles.dotDisabled]} />
    case 'pending':
      return <View style={styles.dotPending} />
  }
}
