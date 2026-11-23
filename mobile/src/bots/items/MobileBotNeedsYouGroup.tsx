// The Items tab's Needs you group on the phone: Orca's asks it can read (approvals first), then the
// items the bot set to Needs you. Five rows, then Show N more; approvals never fold. A tap opens where
// the ask was made, or an access request's decision; a row the phone can't reach is dimmed and says so.
import { useMemo, useState, type ReactNode } from 'react'
import { Text, View } from 'react-native'
import { CircleAlert, CircleHelp, KeyRound, Shield, UserPlus } from 'lucide-react-native'
import { CONNECTOR_SOURCE_NAMES } from '../../../../src/shared/connectors/external-conversation-link'
import { accessRequestPerson } from '../../../../src/shared/bots/bot-access-request'
import { needsYouFold } from '../../../../src/shared/bots/needs-you-fold'
import { botNeedsYouCount } from '../../../../src/shared/bots/bot-now'
import { formatBotItemNumber, type BotItem } from '../../../../src/shared/bots/bot-items'
import { botItemStatusName } from '../../../../src/shared/bots/bot-item-status-name'
import {
  ListGroup,
  ListRow,
  SectionHeader,
  LIST_LEADING_INSET
} from '../../components/list/ListGroup'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import type { Translate } from '../../i18n/mobile-i18n'
import { colors, typography } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { chatSessionId, phoneAskCounts, type PhoneAsk } from './phone-needs-you-asks'
import type { PhoneConnectorNeed } from '../connectors/phone-connector-needs'
import type { ConnectorAccessRequest } from '../../../../src/shared/connector-bot-access-contract'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { useOptionalHostProtocolGates } from '../../components/host-connection/host-protocol-gates-context'
import { structuredAgentSessionHostSupport } from '../../session/native-chat/agent-session/mobile-structured-agent-session-host-support'
import { useMobileStructuredAsyncQuestions } from '../../session/native-chat/agent-session/use-mobile-structured-async-questions'
import { MobileBotTextButton } from '../MobileBotTextButton'
import type { MobileBotAvatarSource } from '../host-bot-row-facts'
import { MobileBotItemOwnerLine } from './MobileBotItemRow'

/** In a group's list: the member an ask is from. */
export type PhoneAskOwner = { name: string; avatar: MobileBotAvatarSource }

type Row = { key: string; approval: boolean; ask?: PhoneAsk; item?: BotItem }

/** The row's title: the desktop's for Home Chat, else the chat's, worker's or item's own. */
function askRowTitle(ask: PhoneAsk, botName: string, t: Translate): string {
  return ask.open && 'chat' in ask.open && ask.open.chat.origin === 'home'
    ? t('bots.needs.chat', 'Your chat with {{name}}', { name: botName })
    : ask.title
}

/** The ask's title as read aloud: an item's number first, as the row shows it. */
function askTitle(ask: PhoneAsk, title: string): string {
  return ask.number === null ? title : `${formatBotItemNumber(ask.number)} ${title}`
}

function askLine(ask: PhoneAsk, t: Translate, question: string | undefined): string {
  const need = ask.approval
    ? ask.tool
      ? t('bots.needs.permissionTool', 'Permission · {{tool}}', { tool: ask.tool.name })
      : t('bots.needs.permission', 'Permission needed')
    : question || t('bots.needs.waiting', 'Waiting for you')
  const line = ask.open
    ? need
    : t('bots.needs.whereItRuns', '{{need}} · open it where it runs', { need })
  return ask.worker
    ? `${t('bots.needs.worker', 'Worker: {{name}}', { name: ask.worker })} · ${line}`
    : line
}

/** One ask; a chat's says the question it waits on without stopping, as its host publishes it,
 *  with Skip to settle it here. */
function AskRow({
  ask,
  botName,
  owner,
  client,
  disabled,
  onOpen,
  onSkipFailed
}: {
  ask: PhoneAsk
  botName: string
  owner: PhoneAskOwner | undefined
  client: RpcClient | null
  disabled: boolean
  onOpen: () => void
  onSkipFailed: (message: string) => void
}) {
  const t = useMobileTranslation()
  const capabilities = useOptionalHostProtocolGates()?.hostCapabilities
  const hostSupport = useMemo(
    () => structuredAgentSessionHostSupport(capabilities ?? []),
    [capabilities]
  )
  const sessionId = ask.open && 'chat' in ask.open ? chatSessionId(ask.open.chat) : null
  const { asyncQuestionSkip } = useMobileStructuredAsyncQuestions(
    { client, sessionId, enabled: sessionId !== null, hostSupport, agent: null },
    null
  )
  // A prompt the turn stopped for is the one it waits on, as on the desktop; Skip is for the others.
  const asked = ask.approval || ask.question ? undefined : asyncQuestionSkip?.awaiting
  const save = asyncQuestionSkip?.save
  const title = askRowTitle(ask, owner?.name ?? botName, t)
  const line = askLine(ask, t, ask.question ?? asked?.text)
  const command = ask.tool?.input ? (
    <Text style={styles.command} numberOfLines={1}>
      {ask.tool.input}
    </Text>
  ) : null
  return (
    <ListRow
      title={title}
      marker={ask.number === null ? undefined : formatBotItemNumber(ask.number)}
      subtitle={owner ? undefined : line}
      subtitleLines={1}
      detail={
        owner ? (
          <>
            <MobileBotItemOwnerLine owner={owner} line={line} />
            {command}
          </>
        ) : (
          (command ?? undefined)
        )
      }
      leading={
        ask.approval ? (
          <Shield size={17} strokeWidth={2.1} color={colors.agentQuestion} />
        ) : (
          <CircleHelp size={17} strokeWidth={2.1} color={colors.agentQuestion} />
        )
      }
      accessory={
        asked && save ? (
          <MobileBotTextButton
            label={t('chat.ask.skip', 'Skip')}
            accessibilityLabel={t('bots.needs.actionFor', '{{action}}: {{title}}', {
              action: t('chat.ask.skip', 'Skip'),
              title: askTitle(ask, title)
            })}
            disabled={disabled}
            onPress={() =>
              void save(asked.itemId).catch(() =>
                onSkipFailed(t('common.loadError.generic', 'Something went wrong. Try again.'))
              )
            }
          />
        ) : undefined
      }
      disabled={disabled || !ask.open}
      accessibilityRole="button"
      accessibilityLabel={t('bots.needs.actionFor', '{{action}}: {{title}}', {
        action: t('bots.needs.open', 'Open'),
        title: askTitle(ask, title)
      })}
      onPress={onOpen}
    />
  )
}

/** Someone asked for access: a tap opens the decision, as the desktop's Review does. */
function AccessAskRow({
  request,
  disabled,
  onOpen
}: {
  request: ConnectorAccessRequest
  disabled: boolean
  onOpen: () => void
}) {
  const t = useMobileTranslation()
  const title = t('bots.needs.access', '{{person}} asked for access', {
    person: accessRequestPerson(request)
  })
  return (
    <ListRow
      title={title}
      subtitle={[CONNECTOR_SOURCE_NAMES[request.source], request.workspaceName]
        .filter(Boolean)
        .join(' · ')}
      subtitleLines={1}
      leading={<UserPlus size={17} strokeWidth={2.1} color={colors.agentQuestion} />}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={t('bots.needs.actionFor', '{{action}}: {{title}}', {
        action: t('bots.accessRequest.review', 'Review'),
        title
      })}
      onPress={onOpen}
    />
  )
}

/** A connector to sign in to or fix: a tap opens its page in Settings › Connectors. */
function ConnectorAskRow({
  need,
  disabled,
  onOpen
}: {
  need: PhoneConnectorNeed
  disabled: boolean
  onOpen: () => void
}) {
  const t = useMobileTranslation()
  return (
    <ListRow
      title={need.title}
      subtitle={need.need}
      subtitleLines={2}
      leading={<KeyRound size={17} strokeWidth={2.1} color={colors.agentQuestion} />}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={t('bots.needs.fixConnector', 'Open {{name}}', { name: need.title })}
      onPress={onOpen}
    />
  )
}

/** A run a sign-in stopped, its mark muted: context for the sign-in above it, not a need of its own. */
function StoppedAskRow({ title, onOpen }: { title: string; onOpen: (() => void) | null }) {
  const t = useMobileTranslation()
  return (
    <ListRow
      title={title}
      subtitle={t('bots.needs.runSignIn', 'Couldn’t run until you sign in.')}
      subtitleLines={1}
      leading={<CircleAlert size={17} strokeWidth={2.1} color={colors.textMuted} />}
      disabled={!onOpen}
      accessibilityRole="button"
      accessibilityLabel={t('bots.needs.actionFor', '{{action}}: {{title}}', {
        action: t('bots.needs.openRun', 'Open run'),
        title
      })}
      onPress={onOpen ?? undefined}
    />
  )
}

export function MobileBotNeedsYouGroup({
  botName,
  asks,
  items,
  disabled,
  renderItem,
  onOpenAsk,
  ownerOf,
  client,
  onSkipFailed
}: {
  botName: string
  asks: readonly PhoneAsk[]
  /** In a group's list: the member each ask is from, named under its title. */
  ownerOf?: (ask: PhoneAsk) => PhoneAskOwner | undefined
  items: readonly BotItem[]
  /** Offline or the read failed: rows stay, taps wait. */
  disabled: boolean
  renderItem: (item: BotItem) => ReactNode
  onOpenAsk: (ask: PhoneAsk) => void
  /** The host's client, which a chat's Skip saves through. */
  client: RpcClient | null
  onSkipFailed: (message: string) => void
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [folded, setFolded] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const rows: Row[] = [
    ...asks.map((ask) => ({ key: ask.key, approval: ask.approval, ask })),
    ...items.map((item) => ({ key: `item:${item.uid}`, approval: false, item }))
  ]
  if (rows.length === 0) {
    return null
  }
  const fold = needsYouFold(rows, { expanded, focusedKey: null, showAll: disabled })
  const shown = new Set(fold.visible)
  return (
    <>
      <SectionHeader
        title={`${botItemStatusName('needs_you', t)} ${botNeedsYouCount(asks.filter(phoneAskCounts).length, items.length)}`}
        expanded={!folded}
        onToggle={() => setFolded(!folded)}
      />
      {folded ? null : (
        <ListGroup separatorInset={LIST_LEADING_INSET}>
          {[
            ...fold.ordered
              .filter((row) => shown.has(row.key))
              .map((row) =>
                row.ask?.open && 'connector' in row.ask.open ? (
                  <ConnectorAskRow
                    key={row.key}
                    need={row.ask.open.connector}
                    disabled={disabled}
                    onOpen={() => onOpenAsk(row.ask!)}
                  />
                ) : row.ask?.open && 'stopped' in row.ask.open ? (
                  <StoppedAskRow
                    key={row.key}
                    title={row.ask.title}
                    onOpen={disabled ? null : () => onOpenAsk(row.ask!)}
                  />
                ) : row.ask?.open && 'access' in row.ask.open ? (
                  <AccessAskRow
                    key={row.key}
                    request={row.ask.open.access}
                    disabled={disabled}
                    onOpen={() => onOpenAsk(row.ask!)}
                  />
                ) : row.ask ? (
                  <AskRow
                    key={row.key}
                    ask={row.ask}
                    botName={botName}
                    owner={ownerOf?.(row.ask)}
                    client={client}
                    disabled={disabled}
                    onOpen={() => onOpenAsk(row.ask!)}
                    onSkipFailed={onSkipFailed}
                  />
                ) : (
                  renderItem(row.item!)
                )
              ),
            ...(fold.hidden > 0
              ? [
                  <ListRow
                    key="more"
                    title={t('bots.items.group.showMore', 'Show {{count}} more', {
                      count: fold.hidden
                    })}
                    leading={<View />}
                    onPress={() => setExpanded(true)}
                  />
                ]
              : [])
          ]}
        </ListGroup>
      )}
    </>
  )
}

const styles = themedStyleSheet(() => ({
  command: {
    fontFamily: typography.monoFamily,
    fontSize: typography.metaSize,
    color: colors.textSecondary,
    marginTop: 2
  }
}))
