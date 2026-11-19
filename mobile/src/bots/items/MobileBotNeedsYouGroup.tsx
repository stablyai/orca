// The Items tab's Needs you group on the phone: Orca's asks it can read (approvals first), then the
// items the bot set to Needs you. Five rows, then Show N more; approvals never fold. A tap opens where
// the ask was made; a row the phone can't reach is dimmed and says so.
import { useMemo, useState, type ReactNode } from 'react'
import { View } from 'react-native'
import { CircleHelp, Shield } from 'lucide-react-native'
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
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { useOptionalHostProtocolGates } from '../../components/host-connection/host-protocol-gates-context'
import { structuredAgentSessionHostSupport } from '../../session/native-chat/agent-session/mobile-structured-agent-session-host-support'
import { useMobileStructuredAsyncQuestions } from '../../session/native-chat/agent-session/use-mobile-structured-async-questions'
import { MobileBotTextButton } from '../MobileBotTextButton'

type Row = { key: string; approval: boolean; ask?: PhoneAsk; item?: BotItem }

/** The ask's title as read aloud: an item's number first, as the row shows it. */
function askTitle(ask: PhoneAsk): string {
  return ask.number === null ? ask.title : `${formatBotItemNumber(ask.number)} ${ask.title}`
}

function askLine(ask: PhoneAsk, t: Translate, question: string | undefined): string {
  const need = ask.approval
    ? ask.tool
      ? [
          t('bots.needs.permissionTool', 'Permission · {{tool}}', { tool: ask.tool.name }),
          ask.tool.input
        ]
          .filter(Boolean)
          .join(' ')
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
  client,
  disabled,
  onOpen,
  onSkipFailed
}: {
  ask: PhoneAsk
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
  const sessionId = ask.open && 'chat' in ask.open ? ask.chatId : null
  const { asyncQuestionSkip } = useMobileStructuredAsyncQuestions(
    { client, sessionId, enabled: sessionId !== null, hostSupport, agent: null },
    null
  )
  const asked = ask.approval ? undefined : asyncQuestionSkip?.awaiting
  const save = asyncQuestionSkip?.save
  return (
    <ListRow
      title={ask.title}
      marker={ask.number === null ? undefined : formatBotItemNumber(ask.number)}
      subtitle={askLine(ask, t, asked?.text)}
      subtitleLines={1}
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
              title: askTitle(ask)
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
        title: askTitle(ask)
      })}
      onPress={onOpen}
    />
  )
}

export function MobileBotNeedsYouGroup({
  asks,
  items,
  disabled,
  renderItem,
  onOpenAsk,
  client,
  onSkipFailed
}: {
  asks: readonly PhoneAsk[]
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
                row.ask ? (
                  <AskRow
                    key={row.key}
                    ask={row.ask}
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
