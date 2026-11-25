// The bot panel's Items tab: Orca's asks leading Needs you whatever the item read says, then the bot's
// items grouped as the desktop groups them (Needs you, In progress and
// Closed open; Planned, Snoozed and Stale folded; a group with no rows not shown), five rows then Show N more. Long-press opens a row's actions;
// Select there starts multi-select, where taps check rows and a floating bar moves them all at once.
import { useMemo, useState, type ReactNode } from 'react'
import { Text, View } from 'react-native'
import { Inbox } from 'lucide-react-native'
import {
  BOT_ITEM_GROUP_IDS,
  BOT_ITEM_GROUP_ROWS,
  BOT_ITEM_GROUPS_FOLDED_BY_DEFAULT,
  filterBotItems,
  groupBotItems,
  isBotItemUnseen,
  type BotItemFilter,
  type BotItemGroupId
} from '../../../../src/shared/bots/bot-item-groups'
import { mergeBotItemsByUid } from '../../../../src/shared/bots/bot-item-merge'
import type { BotItem } from '../../../../src/shared/bots/bot-items'
import { botItemWalkOf, type BotItemWalk } from '../../../../src/shared/bots/bot-item-walk'
import { botItemGroupName } from '../../../../src/shared/bots/bot-item-status-name'
import {
  MobileLoadErrorState,
  MobileNoMatchState,
  MobileOfflineState,
  MobileStateView
} from '../../components/feedback/MobileStateView'
import {
  ListGroup,
  ListRow,
  SectionHeader,
  LIST_LEADING_INSET
} from '../../components/list/ListGroup'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { colors, feedback, radii, spacing, typography } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { MobileBotTextButton } from '../MobileBotTextButton'
import type { PhoneBot } from '../host-bots-operations'
import { MobileBotItemsAllClear } from './MobileBotItemsAllClear'
import { MobileBotItemRow } from './MobileBotItemRow'
import { MobileBotNeedsYouGroup } from './MobileBotNeedsYouGroup'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { openPhoneAsk, type PhoneAsk, type PhoneAskOpeners } from './phone-needs-you-asks'
import type { BotItemSheet } from './MobileBotItemSheets'
import type { PhoneBotItems } from './use-phone-bot-items'

export function MobileBotItemsTab({
  bot,
  items,
  filter,
  onClearFilter,
  staleDays,
  seenEventId,
  now,
  online,
  hostName,
  selected,
  onSelected,
  onOpen,
  setSheet,
  after,
  asks,
  askOpeners,
  client,
  showToast
}: {
  bot: PhoneBot
  items: PhoneBotItems
  filter: BotItemFilter
  onClearFilter: () => void
  staleDays: number | null
  /** The seen mark as the panel opened: rows changed since keep their dot while it stays open. */
  seenEventId: string
  now: number
  online: boolean
  hostName: string
  /** Checked rows; empty when not selecting. */
  selected: ReadonlySet<string>
  onSelected: (next: ReadonlySet<string>) => void
  /** `walk`: the item's section as it shows now, which the item page steps through. */
  onOpen: (item: BotItem, walk: BotItemWalk | null) => void
  setSheet: (sheet: BotItemSheet) => void
  /** Automations and Up next, below the groups as on the desktop; hidden while filtered. */
  after: ReactNode
  /** Orca's asks the phone reads; they lead Needs you whatever the items say. */
  asks: readonly PhoneAsk[]
  askOpeners: PhoneAskOpeners
  client: RpcClient | null
  showToast: (message: string) => void
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const { read } = items
  const botName = bot.name
  const failed = items.error !== null
  const all = useMemo(() => mergeBotItemsByUid(read?.items ?? [], items.items), [read, items.items])
  const shown = useMemo(() => filterBotItems(all, filter), [all, filter])
  const groups = useMemo(
    () => groupBotItems(shown, staleDays, now, seenEventId),
    [shown, staleDays, now, seenEventId]
  )
  const filtered = filter.needsYou
  const below = filtered ? null : after
  const asksOnly = (
    <MobileBotNeedsYouGroup
      botName={botName}
      asks={asks}
      items={[]}
      now={now}
      disabled={!online}
      renderItem={() => null}
      onOpenAsk={(ask) => openPhoneAsk(ask, askOpeners)}
      client={client}
      onSkipFailed={showToast}
    />
  )
  if (!read) {
    return (
      <>
        {asksOnly}
        {!online ? (
          <MobileOfflineState hostName={hostName} />
        ) : failed ? (
          <MobileLoadErrorState
            error={items.error}
            title={t('bots.items.readFailedTitle', 'Couldn’t load items')}
            onRetry={items.retry}
          />
        ) : (
          <MobileStateView loading title={t('bots.items.loading', 'Loading items…')} />
        )}
        {below}
      </>
    )
  }
  const selecting = selected.size > 0
  const closedTotal = filter.needsYou
    ? groups.closed.length
    : (read.counts.done ?? 0) + (read.counts.canceled ?? 0)
  const toggle = (item: BotItem) => {
    const next = new Set(selected)
    if (next.has(item.uid)) {
      next.delete(item.uid)
    } else {
      next.add(item.uid)
    }
    onSelected(next)
  }
  const staleReason =
    staleDays === null
      ? ''
      : t('bots.items.stale.reason', 'No activity for {{count}} days.', { count: staleDays })
  let body: ReactNode
  if (all.length === 0 && !filtered) {
    body = (
      <>
        {asks.length > 0 ? asksOnly : null}
        <MobileStateView
          icon={Inbox}
          title={t('bots.items.empty.title', 'No items yet')}
          message={t(
            'bots.items.empty.body',
            'When {{bot}} takes on something for you, it shows up here with what it is doing and what it needs from you.',
            { bot: botName }
          )}
        />
      </>
    )
  } else if (shown.length === 0 && asks.length > 0) {
    body = asksOnly
  } else if (shown.length === 0) {
    body = (
      <MobileNoMatchState
        message={t('bots.items.empty.needsYou', 'Nothing needs you.')}
        onClear={onClearFilter}
        clearLabel={t('bots.items.filter.clear', 'Clear filter')}
      />
    )
  } else {
    const disabled = failed || !online
    const row = (item: BotItem, id: BotItemGroupId) => (
      <MobileBotItemRow
        key={item.uid}
        item={item}
        stale={id === 'stale'}
        snoozed={id === 'snoozed'}
        unseen={isBotItemUnseen(item, seenEventId)}
        checked={selecting ? selected.has(item.uid) : null}
        now={now}
        disabled={disabled}
        onPress={() =>
          selecting ? toggle(item) : onOpen(item, botItemWalkOf(groups, closedTotal, item.uid))
        }
        onLongPress={() => (selecting ? toggle(item) : setSheet({ kind: 'row', item }))}
      />
    )
    // Paused and offline say so elsewhere, as on the desktop.
    const allClear =
      !filtered &&
      asks.length === 0 &&
      online &&
      !bot.paused &&
      groups.needs_you.length + groups.working.length === 0
    const list = BOT_ITEM_GROUP_IDS.map((id) =>
      id === 'needs_you' ? (
        <MobileBotNeedsYouGroup
          key={id}
          botName={botName}
          asks={asks}
          items={groups.needs_you}
          now={now}
          disabled={disabled}
          renderItem={(item) => row(item, id)}
          onOpenAsk={(ask) => openPhoneAsk(ask, askOpeners)}
          client={client}
          onSkipFailed={showToast}
        />
      ) : (
        <ItemGroup
          key={id}
          id={id}
          items={groups[id]}
          total={id === 'closed' ? Math.max(closedTotal, groups.closed.length) : groups[id].length}
          onMoreClosed={id === 'closed' && !filter.needsYou ? items.loadMoreClosed : null}
          isUnseen={(item) => isBotItemUnseen(item, seenEventId)}
          renderItem={(item) => row(item, id)}
          onCancelAll={
            id === 'stale' && groups.stale.length > 0 && !failed && online
              ? () => setSheet({ kind: 'stale', items: groups.stale, reason: staleReason })
              : null
          }
        />
      )
    )
    body = (
      <>
        {allClear ? <MobileBotItemsAllClear /> : null}
        {list}
      </>
    )
  }
  return (
    <>
      {failed ? <ReadFailed onRetry={items.retry} /> : null}
      <View style={failed ? styles.dimmed : undefined}>{body}</View>
      {below}
    </>
  )
}

/** A re-read that failed, over the last good list it keeps up. */
export function ReadFailed({ onRetry }: { onRetry: () => void }) {
  const t = useMobileTranslation()
  return (
    <ListGroup style={styles.failed}>
      <ListRow
        title={t('bots.items.readFailedShort', 'Couldn’t load items.')}
        subtitle={t('bots.items.lastRead', 'Showing the last items read.')}
        accessory={<MobileBotTextButton label={t('bots.items.retry', 'Retry')} onPress={onRetry} />}
      />
    </ListGroup>
  )
}

/** One folding group under its "Name N" header, five rows then Show N more; Closed reads more pages. */
export function ItemGroup({
  id,
  items,
  total,
  onMoreClosed,
  isUnseen,
  renderItem,
  onCancelAll
}: {
  id: BotItemGroupId
  items: BotItem[]
  total: number
  onMoreClosed: (() => Promise<unknown>) | null
  /** Changed since its bot's Items were last opened. */
  isUnseen: (item: BotItem) => boolean
  renderItem: (item: BotItem) => ReactNode
  onCancelAll: (() => void) | null
}) {
  const t = useMobileTranslation()
  const [folded, setFolded] = useState(BOT_ITEM_GROUPS_FOLDED_BY_DEFAULT.has(id))
  const [shown, setShown] = useState(BOT_ITEM_GROUP_ROWS)
  const [reading, setReading] = useState(false)
  if (total === 0) {
    return null
  }
  const fresh = id === 'closed' ? items.filter(isUnseen) : []
  const more = total - Math.min(shown, items.length)
  const showMore = async () => {
    if (shown + BOT_ITEM_GROUP_ROWS > items.length && onMoreClosed) {
      setReading(true)
      await onMoreClosed().catch(() => {})
      setReading(false)
    }
    setShown(shown + BOT_ITEM_GROUP_ROWS)
  }
  return (
    <View>
      <SectionHeader
        title={`${botItemGroupName(id, t)} ${total}`}
        expanded={!folded}
        onToggle={() => setFolded(!folded)}
        trailing={
          onCancelAll && !folded ? (
            <MobileBotTextButton
              label={t('bots.items.stale.cancelAll', 'Cancel all')}
              onPress={onCancelAll}
            />
          ) : fresh.length > 0 && folded ? (
            <View style={styles.fresh}>
              <View style={styles.unseen} />
              <Text style={styles.freshText}>
                {t('bots.items.group.new', '{{count}} new', { count: fresh.length })}
              </Text>
            </View>
          ) : undefined
        }
      />
      {folded ? null : (
        <ListGroup separatorInset={LIST_LEADING_INSET}>
          {[
            ...items.slice(0, shown).map(renderItem),
            ...(more > 0
              ? [
                  <ListRow
                    key="more"
                    title={t('bots.items.group.showMore', 'Show {{count}} more', { count: more })}
                    busy={reading}
                    leading={<View />}
                    onPress={() => void showMore()}
                  />
                ]
              : [])
          ]}
        </ListGroup>
      )}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  unseen: {
    width: 6,
    height: 6,
    borderRadius: radii.pill,
    backgroundColor: colors.textPrimary
  },
  fresh: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  freshText: { fontSize: typography.metaSize, color: colors.textPrimary },
  dimmed: { opacity: feedback.disabledOpacity },
  failed: { marginBottom: spacing.sm }
}))
