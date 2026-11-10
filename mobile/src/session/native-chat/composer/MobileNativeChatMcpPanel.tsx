import { useCallback, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Text, View } from 'react-native'
import { BottomDrawer } from '../../../components/bottom-drawer/BottomDrawer'
import { ListGroup, ListRow } from '../../../components/list/ListGroup'
import { SheetHeader } from '../../../components/nav-bar/SheetHeader'
import { SheetPrimaryButton } from '../../../components/SheetPrimaryButton'
import { colors, spacing, typography } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import {
  createAgentSessionMcpHook,
  type AgentSessionMcpRequest
} from '../../../../../src/shared/agent-session/view/use-agent-session-mcp'
import { primaryAgentSessionMcpAction } from '../../../../../src/shared/agent-session/view/agent-session-mcp-actions'

const useAgentSessionMcp = createAgentSessionMcpHook({ useCallback, useEffect, useRef, useState })

export function MobileNativeChatMcpPanel({
  request,
  visible,
  onClose,
  offline
}: {
  request: AgentSessionMcpRequest
  visible: boolean
  onClose: () => void
  offline: boolean
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const { servers, pending, failure, run } = useAgentSessionMcp(request)
  const [selected, setSelected] = useState<string | null>(null)
  const server = servers?.find((entry) => entry.name === selected)
  const primary = server ? primaryAgentSessionMcpAction(server) : null
  const locked = offline || pending !== null || failure !== null
  const labels = {
    connected: t('chat.mcp.connected', 'Connected'),
    failed: t('chat.mcp.failed', 'Connection failed'),
    'needs-auth': t('chat.mcp.needsAuth', 'Sign-in required'),
    pending: t('chat.mcp.connecting', 'Connecting'),
    disabled: t('chat.mcp.disabled', 'Disabled')
  }
  const signIn = t('chat.mcp.signIn', 'Sign in')
  const reconnect = t('chat.mcp.reconnect', 'Reconnect')
  const enable = t('chat.mcp.enable', 'Enable')
  const signingIn = pending?.action === 'authenticate' && pending.server === server?.name
  return (
    <BottomDrawer
      visible={visible}
      onClose={onClose}
      onAfterClose={() => setSelected(null)}
      scrollResetKey={selected ?? 'servers'}
    >
      <SheetHeader
        title={t('chat.mcp.title', 'MCP connections')}
        leading={
          server ? { label: t('common.back', 'Back'), onPress: () => setSelected(null) } : undefined
        }
        onClose={onClose}
      />
      <View style={styles.content}>
        {pending && !signingIn && (
          <View style={styles.waiting} accessibilityLiveRegion="polite">
            <ActivityIndicator color={colors.textSecondary} />
            <Text style={styles.caption}>
              {pending.action === 'authenticate'
                ? t(
                    'chat.mcp.waitingForConsent',
                    'Finish sign-in in the browser on the computer running Claude. Waiting up to 3 minutes…'
                  )
                : t('chat.mcp.checking', 'Checking the connection…')}
            </Text>
          </View>
        )}
        {offline || failure ? (
          <Text style={styles.caption} accessibilityRole="alert">
            {offline
              ? t('chat.mcp.offline', 'Reconnect to the computer running Claude, then refresh.')
              : t(
                  'chat.mcp.unconfirmed',
                  'The action could not be confirmed. Refresh to check the connection before trying again.'
                )}
          </Text>
        ) : null}
        {server ? (
          <>
            <View style={styles.summary}>
              <Text selectable style={styles.title}>
                {server.name}
              </Text>
              <Text style={styles.caption}>
                {signingIn
                  ? t('chat.mcp.waiting', 'Waiting for sign-in…')
                  : failure
                    ? t('chat.mcp.lastChecked', 'Last checked: {{status}}', {
                        status: labels[server.status]
                      })
                    : labels[server.status]}
              </Text>
            </View>
            {primary && (
              <SheetPrimaryButton
                label={
                  primary.action === 'authenticate'
                    ? signIn
                    : primary.action === 'toggle'
                      ? enable
                      : reconnect
                }
                disabled={locked}
                busy={signingIn}
                onPress={() => void run(primary)}
              />
            )}
            {signingIn && (
              <Text style={styles.caption} accessibilityLiveRegion="polite">
                {t(
                  'chat.mcp.waitingForConsent',
                  'Finish sign-in in the browser on the computer running Claude. Waiting up to 3 minutes…'
                )}
              </Text>
            )}
            {server.status !== 'disabled' && pending?.action !== 'authenticate' && (
              <ListGroup>
                {primary?.action !== 'reconnect' && (
                  <ListRow
                    title={reconnect}
                    disabled={locked}
                    onPress={() => void run({ action: 'reconnect', server: server.name })}
                  />
                )}
                <ListRow
                  title={t('chat.mcp.disable', 'Disable')}
                  disabled={locked}
                  onPress={() =>
                    void run({ action: 'toggle', server: server.name, enabled: false })
                  }
                />
              </ListGroup>
            )}
            {server.status === 'needs-auth' && !server.canAuthenticate && (
              <Text style={styles.caption}>
                {t(
                  'chat.mcp.terminalRequired',
                  'This server requires sign-in from the Claude terminal on its computer.'
                )}
              </Text>
            )}
          </>
        ) : (
          <ListGroup>
            {servers?.map((entry) => (
              <ListRow
                key={entry.name}
                title={entry.name}
                subtitle={
                  failure
                    ? t('chat.mcp.lastChecked', 'Last checked: {{status}}', {
                        status: labels[entry.status]
                      })
                    : labels[entry.status]
                }
                value={
                  entry.status === 'needs-auth' && entry.canAuthenticate
                    ? signIn
                    : entry.status === 'disabled'
                      ? enable
                      : undefined
                }
                navigates
                onPress={() => setSelected(entry.name)}
              />
            ))}
          </ListGroup>
        )}
        {servers?.length === 0 && (
          <Text style={styles.caption}>
            {t('chat.mcp.empty', 'This session reports no MCP servers.')}
          </Text>
        )}
        {pending?.action !== 'authenticate' && (
          <ListGroup>
            <ListRow
              title={t('chat.mcp.refresh', 'Refresh status')}
              disabled={pending !== null || offline}
              onPress={() => void run({ action: 'status' })}
            />
          </ListGroup>
        )}
        {pending?.action !== 'authenticate' && (
          <Text style={styles.caption}>
            {t('chat.mcp.hostBrowser', 'Sign-in uses the browser on the computer running Claude.')}
          </Text>
        )}
      </View>
    </BottomDrawer>
  )
}

const styles = themedStyleSheet(() => ({
  content: { gap: spacing.md, paddingHorizontal: spacing.lg, paddingBottom: spacing.lg },
  summary: { gap: spacing.xs },
  title: { fontSize: typography.titleSize, fontWeight: '600', color: colors.textPrimary },
  caption: { flexShrink: 1, fontSize: typography.bodySize, color: colors.textSecondary },
  waiting: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm }
}))
