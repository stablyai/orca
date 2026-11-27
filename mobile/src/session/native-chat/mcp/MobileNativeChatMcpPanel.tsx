import { useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native'
import { ChevronRight, X } from 'lucide-react-native'
import type {
  AgentSessionMcpOperation,
  AgentSessionMcpServer,
  AgentSessionMcpSignIn
} from '../../../../../src/shared/agent-session/options/protocol/agent-session-mcp'
import type { AgentSessionMcpPanelState } from '../../../../../src/shared/agent-session/view/use-agent-session-mcp-panel'
import {
  agentSessionMcpRowFailure,
  agentSessionMcpServerDisplayName,
  groupAgentSessionMcpServers,
  ORCA_MCP_SOURCE
} from '../../../../../src/shared/agent-session/view/agent-session-mcp-server-presentation'
import { MobilePendingButton } from '../../../components/controls/MobilePendingButton'
import { MobileSwitch } from '../../../components/controls/MobileSwitch'
import { TextField } from '../../../components/composer-input/TextField'
import type { Translate } from '../../../i18n/mobile-i18n'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { spacing } from '../../../theme/mobile-theme'
import { useMobileColors } from '../../../theme/use-mobile-color-scheme'
import { queuedMessageStylesSheet } from '../input/queued-messages/mobile-native-chat-queued-message-styles'
import { trayStripStylesSheet } from '../input/tasks/mobile-native-chat-tray-strip-styles'
import {
  mobileMcpServerStatusLine,
  mobileMcpSourceLabel,
  mobileMcpTraySummary
} from './mobile-native-chat-mcp-server-copy'
import { mcpPanelStylesSheet as stylesSheet } from './mobile-native-chat-mcp-panel-styles'
import { composerInputStylesSheet } from '../../../components/composer-input/composer-input-styles'
import { useThemedStyles } from '../../../theme/themed-styles'

type McpAction = Exclude<AgentSessionMcpOperation, { action: 'status' }>

export type MobileNativeChatMcpPanelProps = AgentSessionMcpPanelState & {
  run: (operation: McpAction) => void
  retry: () => void
  dismissSignIn: () => void
  openUrl: (url: string) => void
  onClose: () => void
  /** Opens the host's MCP servers page; null on a host without one. */
  onManage?: (() => void) | null
  /** The chat's agent, as the header names it. */
  agentLabel: string
  /** The server list's cap, so the tray and composer stay on screen above the keyboard. */
  listMaxHeight: number
}

/** The `/mcp` tray on the composer's top edge: a summary line over the chat's MCP servers. */
export function MobileNativeChatMcpPanel(props: MobileNativeChatMcpPanelProps): React.JSX.Element {
  const queuedMessageStyles = useThemedStyles(queuedMessageStylesSheet)
  const styles = useThemedStyles(stylesSheet)
  const colors = useMobileColors()
  const t = useMobileTranslation()
  const listed = props.result?.status === 'ok' && props.servers.length > 0
  const summary = listed ? mobileMcpTraySummary(props.servers, props.signIn, t) : []
  return (
    <View
      style={[queuedMessageStyles.box, queuedMessageStyles.composerTab]}
      testID="native-chat-mcp-tray"
    >
      <View style={styles.header}>
        <Text style={styles.headerText} numberOfLines={1}>
          <Text style={styles.title}>{t('chat.mcp.title', 'MCP servers')}</Text>
          {summary.map((part) => (
            <Text key={part.text}>
              <Text style={styles.summary}>{' · '}</Text>
              <Text style={[styles.summary, part.attention && styles.summaryAttention]}>
                {part.text}
              </Text>
            </Text>
          ))}
        </Text>
        {props.result === null ? <ActivityIndicator size="small" color={colors.textMuted} /> : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('common.close', 'Close')}
          hitSlop={spacing.xs}
          style={({ pressed }) => [styles.close, pressed && styles.pressed]}
          onPress={props.onClose}
        >
          <X size={16} color={colors.textMuted} strokeWidth={2} />
        </Pressable>
      </View>
      <McpTrayBody {...props} t={t} />
      {props.onManage ? (
        <Pressable
          accessibilityRole="link"
          style={({ pressed }) => [styles.footer, pressed && styles.pressed]}
          onPress={props.onManage}
        >
          <Text style={styles.footerText}>{t('chat.mcp.manage', 'Manage MCP servers')}</Text>
          <ChevronRight size={15} color={colors.textMuted} strokeWidth={2.2} />
        </Pressable>
      ) : null}
    </View>
  )
}

function McpTrayBody(props: MobileNativeChatMcpPanelProps & { t: Translate }) {
  const { result, servers, t } = props
  if (result === null) {
    return null
  }
  if (result.status === 'unsupported') {
    return (
      <Notice
        text={t(
          'chat.mcp.unsupported',
          "Update Orca on this chat's host to manage MCP servers here."
        )}
      />
    )
  }
  if (result.status === 'failed') {
    return (
      <Notice
        text={result.message ?? t('chat.mcp.readFailed', "Couldn't load MCP servers.")}
        action={
          <McpButton label={t('chat.mcp.retry', 'Retry')} tone="secondary" onPress={props.retry} />
        }
      />
    )
  }
  if (result.status === 'ok' && servers.length === 0) {
    return <Notice text={t('chat.mcp.empty', 'No MCP servers are set up for this chat.')} />
  }
  // An agent at rest lists what its next start gets; one that reports no status says so.
  const notice =
    result.status === 'not-running'
      ? t('chat.mcp.notRunning', 'MCP servers connect when you send your next message.')
      : servers.some((server) => server.status === 'unreported')
        ? t('chat.mcp.unreported', "{{agent}} doesn't report connection status.", {
            agent: props.agentLabel
          })
        : null
  return (
    <>
      {notice ? <Notice text={notice} /> : null}
      {servers.length > 0 ? <McpServerList {...props} /> : null}
    </>
  )
}

function McpServerList(props: MobileNativeChatMcpPanelProps & { t: Translate }) {
  const trayStripStyles = useThemedStyles(trayStripStylesSheet)
  const styles = useThemedStyles(stylesSheet)
  const { servers, t } = props
  const groups = groupAgentSessionMcpServers(servers)
  const withOrca = groups.some((group) => group.source === ORCA_MCP_SOURCE)
  return (
    <ScrollView
      style={[styles.list, { maxHeight: props.listMaxHeight }]}
      contentContainerStyle={styles.listContent}
      keyboardShouldPersistTaps="handled"
      nestedScrollEnabled
    >
      {groups.map((group) => (
        <View key={group.source ?? ''}>
          {/* Servers the agent reports no source for are its own; under Orca's, say whose. */}
          {group.source === null && !withOrca ? null : (
            <Text style={[trayStripStyles.groupLabel, styles.groupLabel]}>
              {group.source === null ? props.agentLabel : mobileMcpSourceLabel(group.source, t)}
            </Text>
          )}
          {group.servers.map((server) => (
            <McpServerRow key={server.name} server={server} {...props} />
          ))}
        </View>
      ))}
    </ScrollView>
  )
}

function Notice({ text, action }: { text: string; action?: React.ReactNode }) {
  const styles = useThemedStyles(stylesSheet)
  return (
    <View style={styles.notice} accessibilityLiveRegion="polite">
      <Text style={styles.noticeText}>{text}</Text>
      {action}
    </View>
  )
}

function McpServerRow({
  server,
  pending,
  signIn,
  failure,
  run,
  dismissSignIn,
  openUrl,
  t
}: MobileNativeChatMcpPanelProps & { server: AgentSessionMcpServer; t: Translate }) {
  const styles = useThemedStyles(stylesSheet)
  const mine = pending !== null && pending.server === server.name ? pending : null
  const signingIn = signIn?.server === server.name ? signIn : null
  const busy = pending !== null
  const action =
    signingIn === null && server.canSignIn && server.status === 'needs-auth'
      ? ({ action: 'signIn', server: server.name } as const)
      : server.canReconnect && server.status === 'failed'
        ? ({ action: 'reconnect', server: server.name } as const)
        : null
  // A toggle in flight shows where it is going.
  const enabled = mine?.action === 'toggle' ? mine.enabled : server.status !== 'disabled'
  const refusal = agentSessionMcpRowFailure(server, failure, signingIn)
  const finishExternal = (): void => run({ action: 'reconnect', server: server.name })
  return (
    <View>
      <View style={styles.row}>
        <View style={styles.mark}>
          <StatusMark status={signingIn ? 'pending' : server.status} />
        </View>
        <Text style={styles.name} numberOfLines={1}>
          {agentSessionMcpServerDisplayName(server)}
        </Text>
        <Text
          style={[
            styles.statusLine,
            !signingIn && server.status === 'failed' && styles.statusLineFailed
          ]}
          numberOfLines={1}
        >
          {signingIn
            ? signingIn.finish === 'external'
              ? t('chat.mcp.status.finishOnPage', 'Finish on the page that opened')
              : t('chat.mcp.status.waitingForSignIn', 'Waiting for sign-in…')
            : mobileMcpServerStatusLine(server, t)}
        </Text>
        {signingIn ? (
          <>
            {signingIn.finish === 'external' ? (
              <McpButton
                label={t('common.done', 'Done')}
                tone="primary"
                busy={mine?.action === 'reconnect'}
                disabled={busy}
                onPress={finishExternal}
              />
            ) : (
              <McpButton
                label={t('chat.mcp.openAgain', 'Open again')}
                tone="plain"
                onPress={() => openUrl(signingIn.url)}
              />
            )}
            <McpButton label={t('common.cancel', 'Cancel')} tone="plain" onPress={dismissSignIn} />
          </>
        ) : (
          <>
            {action ? (
              <McpButton
                label={
                  action.action === 'signIn'
                    ? t('chat.mcp.signIn', 'Sign in')
                    : t('chat.mcp.reconnect', 'Reconnect')
                }
                tone={action.action === 'signIn' ? 'primary' : 'secondary'}
                busy={mine?.action === action.action}
                disabled={busy}
                onPress={() => run(action)}
              />
            ) : null}
            {server.canToggle ? (
              <MobileSwitch
                value={enabled}
                disabled={busy}
                accessibilityLabel={t('chat.mcp.toggleLabel', 'Use {{name}}', {
                  name: server.name
                })}
                onValueChange={(next) =>
                  run({ action: 'toggle', server: server.name, enabled: next })
                }
              />
            ) : null}
          </>
        )}
      </View>
      {refusal ? (
        <Text style={styles.rowFailure} accessibilityLiveRegion="polite">
          {refusal.kind === 'signInUnfinished'
            ? t(
                'chat.mcp.signInUnfinished',
                "Sign-in isn't finished yet. Finish it on the page that opened, then tap Done."
              )
            : (refusal.message ?? t('chat.mcp.actionFailed', "Couldn't do that. Try again."))}
        </Text>
      ) : null}
      {signingIn?.finish === 'callback' ? (
        <McpPasteBox signIn={signingIn} pending={mine} busy={busy} run={run} t={t} />
      ) : null}
    </View>
  )
}

function StatusMark({ status }: { status: AgentSessionMcpServer['status'] }) {
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

// The phone never runs the agent, so a callback sign-in always finishes by pasting the address.
function McpPasteBox({
  signIn,
  pending,
  busy,
  run,
  t
}: {
  signIn: AgentSessionMcpSignIn
  pending: McpAction | null
  busy: boolean
  run: (operation: McpAction) => void
  t: Translate
}) {
  const styles = useThemedStyles(stylesSheet)
  const composerInputStyles = useThemedStyles(composerInputStylesSheet)
  const [address, setAddress] = useState('')
  const callbackUrl = address.trim()
  const finish = (): void => {
    if (callbackUrl) {
      run({ action: 'finishSignIn', server: signIn.server, callbackUrl })
    }
  }
  return (
    <View style={styles.pasteBox}>
      <Text style={styles.pasteHint}>
        {t(
          'chat.mcp.pasteHint',
          "When the browser lands on a page that won't load, copy its address and paste it here."
        )}
      </Text>
      <View style={styles.pasteRow}>
        <TextField
          style={[composerInputStyles.filledField, styles.pasteField]}
          value={address}
          onChangeText={setAddress}
          placeholder={t('chat.mcp.pastePlaceholder', 'Paste address')}
          accessibilityLabel={t('chat.mcp.pasteLabel', 'Sign-in page address')}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          returnKeyType="done"
          onSubmitEditing={finish}
        />
        <McpButton
          label={t('chat.mcp.finish', 'Finish')}
          tone="primary"
          tall
          busy={pending?.action === 'finishSignIn'}
          disabled={busy || !callbackUrl}
          onPress={finish}
        />
      </View>
    </View>
  )
}

function McpButton({
  label,
  tone,
  tall = false,
  busy = false,
  disabled = false,
  onPress
}: {
  label: string
  tone: 'primary' | 'secondary' | 'plain'
  tall?: boolean
  busy?: boolean
  disabled?: boolean
  onPress: () => void
}) {
  const styles = useThemedStyles(stylesSheet)
  const colors = useMobileColors()
  return (
    <MobilePendingButton
      label={label}
      pending={busy}
      disabled={disabled}
      onPress={onPress}
      hitSlop={tall ? undefined : 6}
      style={[
        styles.button,
        tall && styles.buttonTall,
        tone === 'primary' && styles.buttonPrimary,
        tone === 'secondary' && styles.buttonSecondary,
        tone === 'plain' && styles.buttonPlain
      ]}
      labelStyle={[
        styles.buttonLabel,
        tone === 'primary' && styles.buttonLabelPrimary,
        tone === 'plain' && styles.buttonLabelPlain
      ]}
      spinnerColor={tone === 'primary' ? colors.bgBase : colors.textPrimary}
    />
  )
}
