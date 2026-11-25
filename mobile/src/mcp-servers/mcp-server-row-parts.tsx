// Small pieces every MCP server screen draws: a server's mark, the tray's status dot, and a
// label-over-value row for a command, its arguments and its secrets.
import { Image, Text, View } from 'react-native'
import { Globe, Lock, SquareTerminal } from '../components/icons/app-icons'
import { composioLogoUrl } from '../../../src/shared/composio/composio-apps'
import { MobileConnectorLogo } from '../bots/MobileConnectorSourceIcon'
import { LIST_ROW_PADDING } from '../components/list/ListGroup'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { PhoneMcpServer } from './mcp-server-operations'
import { mcpCatalogEntryOf } from './mcp-server-words'

const LOGO = 20

/** A catalog app's logo, as Add lists it; any other server by what it is. */
export function McpServerMark({
  server
}: {
  server: Pick<PhoneMcpServer, 'name' | 'detail' | 'transport'>
}) {
  useMobileColorScheme()
  const app = mcpCatalogEntryOf(server)
  if (app) {
    return <McpAppLogo slug={app.id} />
  }
  const Icon = server.transport === 'command' ? SquareTerminal : Globe
  return <Icon size={18} color={colors.textSecondary} />
}

export function McpAppLogo({ slug }: { slug: string }) {
  // Orca's own marks follow the theme; Composio's GitHub logo is black on the dark page.
  if (slug === 'github' || slug === 'linear') {
    return <MobileConnectorLogo source={slug} size={LOGO} />
  }
  return <Image source={{ uri: composioLogoUrl(slug) }} style={styles.logo} />
}

/** The tray's 7 pt status dot before a line: amber needs the user, red is a failure. */
export function McpStatusDot({ tone }: { tone: 'amber' | 'red' }) {
  useMobileColorScheme()
  return (
    <View
      style={[
        styles.dot,
        { backgroundColor: tone === 'red' ? colors.statusRed : colors.statusAmber }
      ]}
    />
  )
}

/** A detail as the mocks draw it: a small label, then the value in the code face. */
export function McpDetailRow({
  label,
  value,
  secret = false
}: {
  label: string
  value: string
  /** A saved secret: dots and a lock, never the value. */
  secret?: boolean
}) {
  useMobileColorScheme()
  return (
    <View style={styles.detail} accessible accessibilityLabel={`${label}, ${secret ? '' : value}`}>
      <Text style={styles.label} numberOfLines={1}>
        {label}
      </Text>
      <View style={styles.valueLine}>
        <Text style={styles.value} selectable={!secret}>
          {secret ? '••••••••••••' : value}
        </Text>
        {secret ? <Lock size={13} color={colors.textSecondary} /> : null}
      </View>
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  logo: { width: LOGO, height: LOGO, borderRadius: radii.mark },
  // On the subtitle's first line, not the middle of a wrapped one.
  dot: { width: 7, height: 7, borderRadius: 3.5, alignSelf: 'flex-start', marginTop: 4.5 },
  detail: {
    paddingHorizontal: LIST_ROW_PADDING,
    paddingVertical: 10,
    gap: 2
  },
  label: { fontSize: 12.5, color: colors.textSecondary },
  valueLine: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  value: {
    flexShrink: 1,
    fontFamily: typography.monoFamily,
    fontSize: 13,
    lineHeight: 19,
    color: colors.textPrimary
  }
}))
