import { useState } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import type {
  AgentSessionMcpOperation,
  AgentSessionMcpServer,
  AgentSessionMcpSignIn
} from '../../../../../src/shared/agent-session/agent-session-mcp'
import type { AgentSessionMcpPanelState } from '../../../../../src/shared/agent-session/view/use-agent-session-mcp-panel'
import {
  LIST_LEADING_INSET,
  ListGroup,
  ListRow,
  SectionHeader
} from '../../../components/list/ListGroup'
import { MobileSwitch } from '../../../components/MobileSwitch'
import { TextField } from '../../../components/composer-input/TextField'
import { SheetHeader } from '../../../components/nav-bar/SheetHeader'
import type { Translate } from '../../../i18n/mobile-i18n'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { colors } from '../../../theme/mobile-theme'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import {
  mobileMcpServerStatusLine,
  mobileMcpSourceLabel
} from './mobile-native-chat-mcp-server-copy'
import {
  agentSessionMcpRowFailure,
  agentSessionMcpServerDisplayName,
  groupAgentSessionMcpServers
} from '../../../../../src/shared/agent-session/view/agent-session-mcp-server-presentation'
import { mcpPanelStyles as styles } from './mobile-native-chat-mcp-panel-styles'

type McpAction = Exclude<AgentSessionMcpOperation, { action: 'status' }>

export type MobileNativeChatMcpPanelProps = AgentSessionMcpPanelState & {
  run: (operation: McpAction) => void
  retry: () => void
  dismissSignIn: () => void
  openUrl: (url: string) => void
  onClose: () => void
}

/** The `/mcp` sheet's page: the chat's MCP servers grouped by where the agent found them. */
export function MobileNativeChatMcpPanel(props: MobileNativeChatMcpPanelProps): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  return (
    <View style={styles.sheet}>
      <View style={styles.header}>
        <SheetHeader title={t('chat.mcp.title', 'MCP servers')} onClose={props.onClose} />
      </View>
      <McpPanelBody {...props} t={t} />
    </View>
  )
}

function McpPanelBody(props: MobileNativeChatMcpPanelProps & { t: Translate }) {
  const { result, servers, t } = props
  if (result === null) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={colors.textSecondary} />
      </View>
    )
  }
  if (result.status === 'not-running') {
    return (
      <Notice
        text={t('chat.mcp.notRunning', 'MCP servers connect when you send your next message.')}
      />
    )
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
  if (servers.length === 0) {
    return <Notice text={t('chat.mcp.empty', 'No MCP servers are set up for this chat.')} />
  }
  return (
    <>
      {groupAgentSessionMcpServers(servers).map((group, index) => (
        <View key={group.source ?? ''}>
          {group.source === null ? (
            <View style={styles.pageTop} />
          ) : (
            <SectionHeader title={mobileMcpSourceLabel(group.source, t)} first={index === 0} />
          )}
          <ListGroup separatorInset={LIST_LEADING_INSET}>
            {group.servers.map((server) => (
              <McpServerRow key={server.name} server={server} {...props} />
            ))}
          </ListGroup>
        </View>
      ))}
    </>
  )
}

function Notice({ text, action }: { text: string; action?: React.ReactNode }) {
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
  return (
    <View>
      <ListRow
        title={agentSessionMcpServerDisplayName(server)}
        leading={<StatusMark status={server.status} />}
        detail={
          <Text
            style={[styles.statusLine, server.status === 'failed' && styles.statusLineFailed]}
            numberOfLines={2}
          >
            {mobileMcpServerStatusLine(server, t)}
          </Text>
        }
        accessory={
          action || server.canToggle ? (
            <View style={styles.accessory}>
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
            </View>
          ) : undefined
        }
      />
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
      {signingIn ? (
        <McpSignIn
          signIn={signingIn}
          pending={mine}
          busy={busy}
          run={run}
          openUrl={openUrl}
          onCancel={dismissSignIn}
          t={t}
        />
      ) : null}
    </View>
  )
}

function StatusMark({ status }: { status: AgentSessionMcpServer['status'] }) {
  switch (status) {
    case 'connected':
      return <View style={[styles.dot, styles.dotConnected]} />
    case 'needs-auth':
      return <View style={[styles.dot, styles.dotNeedsAuth]} />
    case 'failed':
      return <View style={[styles.dot, styles.dotFailed]} />
    case 'disabled':
      return <View style={[styles.dot, styles.dotDisabled]} />
    case 'pending':
      return <View style={styles.dotPending} />
  }
}

// The phone never runs the agent, so a callback sign-in always finishes by pasting the address.
function McpSignIn({
  signIn,
  pending,
  busy,
  run,
  openUrl,
  onCancel,
  t
}: {
  signIn: AgentSessionMcpSignIn
  pending: McpAction | null
  busy: boolean
  run: (operation: McpAction) => void
  openUrl: (url: string) => void
  onCancel: () => void
  t: Translate
}) {
  const [address, setAddress] = useState('')
  const callbackUrl = address.trim()
  const finish = (): void => {
    if (signIn.finish === 'external') {
      run({ action: 'reconnect', server: signIn.server })
    } else if (callbackUrl) {
      run({ action: 'finishSignIn', server: signIn.server, callbackUrl })
    }
  }
  const finishing =
    pending?.action === (signIn.finish === 'external' ? 'reconnect' : 'finishSignIn')
  const secondary = (
    <View style={styles.signInActions}>
      <McpButton
        label={t('chat.mcp.openAgain', 'Open again')}
        tone="secondary"
        onPress={() => openUrl(signIn.url)}
      />
      <McpButton label={t('common.cancel', 'Cancel')} tone="plain" onPress={onCancel} />
    </View>
  )
  if (signIn.finish === 'external') {
    return (
      <View style={styles.signIn}>
        <Text style={styles.signInText}>
          {t(
            'chat.mcp.externalSignIn',
            'Finish signing in on the page that opened, then tap Done.'
          )}
        </Text>
        <View style={styles.signInActions}>
          <McpButton
            label={t('common.done', 'Done')}
            tone="primary"
            busy={finishing}
            disabled={busy}
            onPress={finish}
          />
          {secondary}
        </View>
      </View>
    )
  }
  return (
    <View style={styles.signIn}>
      <Text style={styles.signInText}>
        {t(
          'chat.mcp.pasteSignIn',
          "Sign-in opens in your browser. When it lands on a page that won't load, copy its address and paste it here."
        )}
      </Text>
      <View style={styles.pasteRow}>
        <TextField
          style={styles.pasteField}
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
          busy={finishing}
          disabled={busy || !callbackUrl}
          onPress={finish}
        />
      </View>
      {secondary}
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
  const foreground = tone === 'primary' ? colors.bgBase : colors.textPrimary
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled || busy, busy }}
      disabled={disabled || busy}
      onPress={onPress}
      hitSlop={tall ? undefined : 6}
      style={({ pressed }) => [
        styles.button,
        tall && styles.buttonTall,
        tone === 'primary' && styles.buttonPrimary,
        tone === 'secondary' && styles.buttonSecondary,
        tone === 'plain' && styles.buttonPlain,
        pressed && styles.buttonPressed,
        disabled && !busy && styles.buttonDisabled
      ]}
    >
      {/* The label keeps the button's width while it spins. */}
      <Text
        style={[
          styles.buttonLabel,
          tone === 'primary' && styles.buttonLabelPrimary,
          tone === 'plain' && styles.buttonLabelPlain,
          busy && styles.buttonLabelHidden
        ]}
        numberOfLines={1}
      >
        {label}
      </Text>
      {busy ? (
        <ActivityIndicator size="small" color={foreground} style={styles.buttonSpinner} />
      ) : null}
    </Pressable>
  )
}
