// The bot panel's Items tab: Orca's asks leading Needs you whatever the item read says, then the bot's
// items grouped as the desktop groups them (Needs you, In progress and
// Closed open; Planned, Snoozed and Stale folded; a group with no rows not shown), five rows then Show N more. Long-press opens a row's actions;
// Select there starts multi-select, where taps check rows and a floating bar moves them all at once.
import { useMemo, useState, type ReactNode } from 'react'
import { Text, View } from 'react-native'
import { X } from 'lucide-react-native'
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
import { botItemGroupName } from '../../../../src/shared/bots/bot-item-status-name'
import { FilterChip } from '../../components/nav-bar/FilterChip'
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
import { sheetStyles } from '../mobile-bot-sheet-styles'
import { MobileBotItemRow } from './MobileBotItemRow'
import { MobileBotNeedsYouGroup } from './MobileBotNeedsYouGroup'
import { openPhoneAsk, type PhoneAsk, type PhoneAskOpeners } from './phone-needs-you-asks'
import type { BotItemSheet } from './MobileBotItemSheets'
import type { PhoneBotItems } from './use-phone-bot-items'

export function MobileBotItemsTab({
  botName,
  items,
  filter,
  filterLabel,
  onClearFilter,
  staleDays,
  seenEventId,
  now,
  online,
  selected,
  onSelected,
  onOpen,
  setSheet,
  after,
  asks,
  askOpeners
}: {
  botName: string
  items: PhoneBotItems
  filter: BotItemFilter
  /** The filter's chip text; null while nothing is filtered. */
  filterLabel: string | null
  onClearFilter: () => void
  staleDays: number | null
  /** The seen mark as the panel opened: rows changed since keep their dot while it stays open. */
  seenEventId: string
  now: number
  online: boolean
  /** Checked rows; empty when not selecting. */
  selected: ReadonlySet<string>
  onSelected: (next: ReadonlySet<string>) => void
  onOpen: (item: BotItem) => void
  setSheet: (sheet: BotItemSheet) => void
  /** Automations and Up next, below the groups as on the desktop. */
  after: ReactNode
  /** Orca's asks the phone reads, as the filter keeps them; they lead Needs you whatever the items say. */
  asks: readonly PhoneAsk[]
  askOpeners: PhoneAskOpeners
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const { read } = items
  const all = useMemo(() => mergeBotItemsByUid(read?.items ?? [], items.items), [read, items.items])
  const shown = useMemo(() => filterBotItems(all, filter), [all, filter])
  const groups = useMemo(
    () => groupBotItems(shown, staleDays, now, seenEventId),
    [shown, staleDays, now, seenEventId]
  )
  const chip = filterLabel ? (
    <View style={styles.chipRow}>
      <FilterChip
        label={filterLabel}
        icon={X}
        active
        onPress={onClearFilter}
        accessibilityLabel={t('bots.items.filter.remove', 'Remove filter {{name}}', {
          name: filterLabel
        })}
      />
    </View>
  ) : null
  const asksOnly = (
    <MobileBotNeedsYouGroup
      asks={asks}
      items={[]}
      disabled={!online}
      renderItem={() => null}
      onOpenAsk={(ask) => openPhoneAsk(ask, askOpeners)}
    />
  )
  if (!read) {
    return (
      <>
        {chip}
        {asksOnly}
        {items.failed ? (
          <ReadFailed stale={false} onRetry={items.retry} />
        ) : (
          <Text style={sheetStyles.empty}>{t('bots.items.loading', 'Loading items…')}</Text>
        )}
        {after}
      </>
    )
  }
  const filtered = filterLabel !== null
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
  if (all.length === 0 && !filtered && asks.length > 0) {
    body = (
      <>
        {asksOnly}
        <Text style={sheetStyles.empty}>
          {t(
            'bots.items.empty.short',
            'No items yet. When {{bot}} takes something on, it shows up here.',
            { bot: botName }
          )}
        </Text>
      </>
    )
  } else if (all.length === 0 && !filtered) {
    body = (
      <View style={styles.empty}>
        <Text style={styles.emptyTitle}>{t('bots.items.empty.title', 'No items yet')}</Text>
        <Text style={styles.emptyBody}>
          {t(
            'bots.items.empty.body',
            'When {{bot}} takes on something for you, it shows up here with what it is doing and what it needs from you.',
            { bot: botName }
          )}
        </Text>
      </View>
    )
  } else if (shown.length === 0 && asks.length > 0) {
    body = asksOnly
  } else if (shown.length === 0) {
    body = (
      <Text style={sheetStyles.empty}>
        {filter.needsYou
          ? t('bots.items.empty.needsYou', 'Nothing needs you.')
          : t('bots.items.empty.filtered', 'No items match.')}
      </Text>
    )
  } else {
    const disabled = items.failed || !online
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
        onPress={() => (selecting ? toggle(item) : onOpen(item))}
        onLongPress={() => (selecting ? toggle(item) : setSheet({ kind: 'row', item }))}
      />
    )
    body = BOT_ITEM_GROUP_IDS.map((id) =>
      id === 'needs_you' ? (
        <MobileBotNeedsYouGroup
          key={id}
          asks={asks}
          items={groups.needs_you}
          disabled={disabled}
          renderItem={(item) => row(item, id)}
          onOpenAsk={(ask) => openPhoneAsk(ask, askOpeners)}
        />
      ) : (
        <ItemGroup
          key={id}
          id={id}
          items={groups[id]}
          total={id === 'closed' ? Math.max(closedTotal, groups.closed.length) : groups[id].length}
          onMoreClosed={id === 'closed' && !filter.needsYou ? items.loadMoreClosed : null}
          seenEventId={seenEventId}
          renderItem={(item) => row(item, id)}
          onCancelAll={
            id === 'stale' && groups.stale.length > 0 && !items.failed && online
              ? () => setSheet({ kind: 'stale', items: groups.stale, reason: staleReason })
              : null
          }
        />
      )
    )
  }
  return (
    <>
      {chip}
      {items.failed ? <ReadFailed stale onRetry={items.retry} /> : null}
      <View style={items.failed ? styles.dimmed : undefined}>{body}</View>
      {after}
    </>
  )
}

function ReadFailed({ stale, onRetry }: { stale: boolean; onRetry: () => void }) {
  const t = useMobileTranslation()
  return (
    <ListGroup style={styles.failed}>
      <ListRow
        title={t('bots.items.readFailedShort', 'Couldn’t load items.')}
        subtitle={stale ? t('bots.items.lastRead', 'Showing the last items read.') : undefined}
        accessory={<MobileBotTextButton label={t('bots.items.retry', 'Retry')} onPress={onRetry} />}
      />
    </ListGroup>
  )
}

function ItemGroup({
  id,
  items,
  total,
  onMoreClosed,
  seenEventId,
  renderItem,
  onCancelAll
}: {
  id: BotItemGroupId
  items: BotItem[]
  total: number
  onMoreClosed: (() => Promise<void>) | null
  seenEventId: string
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
  const fresh = id === 'closed' ? items.filter((item) => isBotItemUnseen(item, seenEventId)) : []
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
  chipRow: { flexDirection: 'row', paddingHorizontal: spacing.xs, marginBottom: spacing.xs },
  unseen: {
    width: 6,
    height: 6,
    borderRadius: radii.pill,
    backgroundColor: colors.textPrimary
  },
  fresh: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  freshText: { fontSize: typography.metaSize, color: colors.textPrimary },
  dimmed: { opacity: feedback.disabledOpacity },
  failed: { marginBottom: spacing.sm },
  empty: {
    alignItems: 'center',
    paddingVertical: spacing.xl,
    paddingHorizontal: spacing.lg,
    gap: spacing.sm
  },
  emptyTitle: { fontSize: typography.bodySize, fontWeight: '600', color: colors.textPrimary },
  emptyBody: { fontSize: 13, color: colors.textMuted, textAlign: 'center', lineHeight: 18 }
}))
