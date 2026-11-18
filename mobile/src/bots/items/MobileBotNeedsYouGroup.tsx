// The Items tab's Needs you group on the phone: Orca's asks it can read (approvals first), then the
// items the bot set to Needs you. Five rows, then Show N more; approvals never fold. A tap opens where
// the ask was made; a row the phone can't reach is dimmed and says so.
import { useState, type ReactNode } from 'react'
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

type Row = { key: string; approval: boolean; ask?: PhoneAsk; item?: BotItem }

/** The ask's title as read aloud: an item's number first, as the row shows it. */
function askTitle(ask: PhoneAsk): string {
  return ask.number === null ? ask.title : `${formatBotItemNumber(ask.number)} ${ask.title}`
}

function askLine(ask: PhoneAsk, t: Translate): string {
  const need = ask.approval
    ? ask.tool
      ? [
          t('bots.needs.permissionTool', 'Permission · {{tool}}', { tool: ask.tool.name }),
          ask.tool.input
        ]
          .filter(Boolean)
          .join(' ')
      : t('bots.needs.permission', 'Permission needed')
    : t('bots.needs.waiting', 'Waiting for you')
  const line = ask.open
    ? need
    : t('bots.needs.whereItRuns', '{{need}} · open it where it runs', { need })
  return ask.worker
    ? `${t('bots.needs.worker', 'Worker: {{name}}', { name: ask.worker })} · ${line}`
    : line
}

export function MobileBotNeedsYouGroup({
  asks,
  items,
  disabled,
  renderItem,
  onOpenAsk
}: {
  asks: readonly PhoneAsk[]
  items: readonly BotItem[]
  /** Offline or the read failed: rows stay, taps wait. */
  disabled: boolean
  renderItem: (item: BotItem) => ReactNode
  onOpenAsk: (ask: PhoneAsk) => void
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
                  <ListRow
                    key={row.key}
                    title={row.ask.title}
                    marker={
                      row.ask.number === null ? undefined : formatBotItemNumber(row.ask.number)
                    }
                    subtitle={askLine(row.ask, t)}
                    subtitleLines={1}
                    leading={
                      row.ask.approval ? (
                        <Shield size={17} strokeWidth={2.1} color={colors.agentQuestion} />
                      ) : (
                        <CircleHelp size={17} strokeWidth={2.1} color={colors.agentQuestion} />
                      )
                    }
                    disabled={disabled || !row.ask.open}
                    accessibilityRole="button"
                    accessibilityLabel={t('bots.needs.actionFor', '{{action}}: {{title}}', {
                      action: t('bots.needs.open', 'Open'),
                      title: askTitle(row.ask)
                    })}
                    onPress={() => onOpenAsk(row.ask!)}
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
