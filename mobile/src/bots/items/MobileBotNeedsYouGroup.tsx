// The Items tab's Needs you group on the phone: approvals, then questions (chats, workers, the items
// the bot set to Needs you), then access requests, then one row for every connector sign-in. Each row
// is a glyph, a title, one line and its age. Five rows, then Show N more; approvals never fold. A tap
// opens where the ask was made, or an access request's decision; a row the phone can't reach is dimmed.
import { useMemo, useState, type ReactNode } from 'react'
import { View } from 'react-native'
import { CircleHelp, KeyRound, Shield, UserPlus } from 'lucide-react-native'
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
import { colors } from '../../theme/mobile-theme'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import type { PhoneAsk } from './phone-needs-you-asks'
import { chatSessionId } from './use-phone-chat-prompts'
import type { PhoneConnectorNeed } from '../connectors/phone-connector-needs'
import type { ConnectorAccessRequest } from '../../../../src/shared/connector-bot-access-contract'
import type { PairedServerAskCard } from '../../../../src/shared/rpc-contract/paired-server-asks-params'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { useOptionalHostProtocolGates } from '../../components/host-connection/host-protocol-gates-context'
import { structuredAgentSessionHostSupport } from '../../session/native-chat/agent-session/mobile-structured-agent-session-host-support'
import { useMobileStructuredAsyncQuestions } from '../../session/native-chat/agent-session/use-mobile-structured-async-questions'
import { MobileBotTextButton } from '../MobileBotTextButton'
import type { MobileBotAvatarSource } from '../host-bot-row-facts'
import { MobileBotAskAge, MobileBotItemOwnerLine } from './MobileBotItemRow'

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

/** One line: the worker that asks, then the tool and what it would run, or the question. */
function askLine(ask: PhoneAsk, t: Translate, question: string | undefined): string {
  const need = ask.approval
    ? ask.tool
      ? [ask.tool.name, ask.tool.input].filter(Boolean).join(' · ')
      : t('bots.needs.permission', 'Permission needed')
    : question || t('bots.needs.waiting', 'Waiting for you')
  const line = ask.open
    ? need
    : t('bots.needs.whereItRuns', '{{need}} · open it where it runs', { need })
  return ask.worker ? `${ask.worker} · ${line}` : line
}

const NEED_GLYPH = { size: 17, strokeWidth: 2.1 } as const

/** One ask; a chat's says the question it waits on without stopping, as its host publishes it,
 *  with Skip to settle it here. */
function AskRow({
  ask,
  botName,
  owner,
  now,
  client,
  disabled,
  onOpen,
  onSkipFailed
}: {
  ask: PhoneAsk
  botName: string
  owner: PhoneAskOwner | undefined
  now: number
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
  return (
    <ListRow
      title={title}
      titlePrefix={ask.number === null ? undefined : formatBotItemNumber(ask.number)}
      subtitle={owner ? undefined : line}
      subtitleLines={1}
      detail={owner ? <MobileBotItemOwnerLine owner={owner} line={line} /> : undefined}
      leading={
        ask.approval ? (
          <Shield {...NEED_GLYPH} color={colors.agentQuestion} />
        ) : (
          <CircleHelp {...NEED_GLYPH} color={colors.agentQuestion} />
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
        ) : ask.at !== null ? (
          <MobileBotAskAge at={ask.at} now={now} />
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
  now,
  disabled,
  onOpen
}: {
  request: ConnectorAccessRequest
  now: number
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
      leading={<UserPlus {...NEED_GLYPH} color={colors.agentQuestion} />}
      accessory={<MobileBotAskAge at={request.createdAt} now={now} />}
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

/** A paired server's agent waiting to message the bot: a tap opens the Home chat, where its card
 *  waits, as the desktop's Open does. */
function PairedAskRow({
  ask,
  card,
  botName,
  now,
  disabled,
  onOpen
}: {
  ask: PhoneAsk
  card: PairedServerAskCard
  botName: string
  now: number
  disabled: boolean
  onOpen: (() => void) | null
}) {
  const t = useMobileTranslation()
  const name = card.botName ?? botName
  const title = t('bots.needs.pairedAsk', '{{from}} wants to message {{name}}', {
    from: ask.title,
    name
  })
  return (
    <ListRow
      title={title}
      subtitle={[card.serverName, card.subject].filter(Boolean).join(' · ')}
      subtitleLines={1}
      leading={<Shield {...NEED_GLYPH} color={colors.agentQuestion} />}
      accessory={ask.at !== null ? <MobileBotAskAge at={ask.at} now={now} /> : undefined}
      disabled={disabled || !onOpen}
      accessibilityRole="button"
      accessibilityLabel={t('bots.needs.actionFor', '{{action}}: {{title}}', {
        action: t('bots.needs.open', 'Open'),
        title
      })}
      onPress={onOpen ?? undefined}
    />
  )
}

/** Every connector to sign in to or fix, as one row: one names itself and opens its page; several are
 *  counted and open Connectors, which lists them. */
function ConnectorsAskRow({
  needs,
  disabled,
  onOpen
}: {
  needs: readonly PhoneConnectorNeed[]
  disabled: boolean
  onOpen: () => void
}) {
  const t = useMobileTranslation()
  const [only] = needs
  const several = needs.length > 1
  const title = several
    ? t('bots.needs.signInApps', 'Sign in to {{count}} apps', { count: needs.length })
    : only.title
  return (
    <ListRow
      title={title}
      subtitle={
        several
          ? [...new Set(needs.map((need) => need.service))].join(
              t('bots.needs.listSeparator', ', ')
            )
          : only.need
      }
      subtitleLines={1}
      leading={<KeyRound {...NEED_GLYPH} color={colors.agentQuestion} />}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={t('bots.needs.fixConnector', 'Open {{name}}', { name: title })}
      onPress={onOpen}
    />
  )
}

export function MobileBotNeedsYouGroup({
  botName,
  asks,
  items,
  now,
  disabled,
  renderItem,
  onOpenAsk,
  ownerOf,
  client,
  onSkipFailed
}: {
  botName: string
  /** Approvals and questions first; access requests and the connectors' row last. */
  asks: readonly PhoneAsk[]
  /** In a group's list: the member each ask is from, named under its title. */
  ownerOf?: (ask: PhoneAsk) => PhoneAskOwner | undefined
  items: readonly BotItem[]
  now: number
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
  const last = (ask: PhoneAsk) =>
    ask.open !== null && ('access' in ask.open || 'connectors' in ask.open)
  const askRow = (ask: PhoneAsk): Row => ({ key: ask.key, approval: ask.approval, ask })
  // Items are questions too: after the chats' asks, before access and sign-ins.
  const rows: Row[] = [
    ...asks.filter((ask) => !last(ask)).map(askRow),
    ...items.map((item) => ({ key: `item:${item.uid}`, approval: false, item })),
    ...asks.filter(last).map(askRow)
  ]
  if (rows.length === 0) {
    return null
  }
  const fold = needsYouFold(rows, { expanded, focusedKey: null, showAll: disabled })
  const shown = new Set(fold.visible)
  return (
    <>
      <SectionHeader
        title={`${botItemStatusName('needs_you', t)} ${botNeedsYouCount(asks.length, items.length)}`}
        expanded={!folded}
        onToggle={() => setFolded(!folded)}
      />
      {folded ? null : (
        <ListGroup separatorInset={LIST_LEADING_INSET}>
          {[
            ...fold.ordered
              .filter((row) => shown.has(row.key))
              .map((row) =>
                row.ask?.open && 'connectors' in row.ask.open ? (
                  <ConnectorsAskRow
                    key={row.key}
                    needs={row.ask.open.connectors}
                    disabled={disabled}
                    onOpen={() => onOpenAsk(row.ask!)}
                  />
                ) : row.ask?.open && 'pairedAsk' in row.ask.open ? (
                  <PairedAskRow
                    key={row.key}
                    ask={row.ask}
                    card={row.ask.open.pairedAsk.card}
                    botName={botName}
                    now={now}
                    disabled={disabled}
                    onOpen={row.ask.open.pairedAsk.home ? () => onOpenAsk(row.ask!) : null}
                  />
                ) : row.ask?.open && 'access' in row.ask.open ? (
                  <AccessAskRow
                    key={row.key}
                    request={row.ask.open.access}
                    now={now}
                    disabled={disabled}
                    onOpen={() => onOpenAsk(row.ask!)}
                  />
                ) : row.ask ? (
                  <AskRow
                    key={row.key}
                    ask={row.ask}
                    botName={botName}
                    owner={ownerOf?.(row.ask)}
                    now={now}
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
