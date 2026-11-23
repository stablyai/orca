// One row of the Items tab: its status glyph (a check circle while selecting), title, the bot's
// question under a Needs you row, the unseen dot and its age (a snoozed row's wake time); and the floating
// bar while rows are checked.
import { Pressable, Text, View } from 'react-native'
import { Circle, CircleCheck, X } from 'lucide-react-native'
import {
  botItemActivityAt,
  formatBotItemNumber,
  isBotItemLive,
  type BotItem
} from '../../../../src/shared/bots/bot-items'
import { botItemStatusName } from '../../../../src/shared/bots/bot-item-status-name'
import { ListRow } from '../../components/list/ListGroup'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { colors, feedback, radii, spacing, typography } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { formatTimeAgo } from '../../worktree/agent-lineage/agent-row-display'
import { MobileBotItemStatusIcon } from './MobileBotItemStatusIcon'
import { formatPhoneSnoozeTime } from './bot-item-snooze-time'
import { MobileBotAvatar } from '../MobileBotAvatar'
import type { MobileBotAvatarSource } from '../host-bot-row-facts'

export function MobileBotItemRow({
  item,
  stale,
  snoozed = false,
  unseen,
  checked,
  now,
  disabled,
  onPress,
  onLongPress,
  owner
}: {
  item: BotItem
  stale: boolean
  /** In the Snoozed group: grey like Stale, its wake time where the age goes. */
  snoozed?: boolean
  unseen: boolean
  /** Selecting: whether this row is checked; null otherwise. */
  checked: boolean | null
  now: number
  disabled: boolean
  onPress: () => void
  onLongPress: () => void
  /** In a group's list: the bot the item is from, named under its title. */
  owner?: { name: string; avatar: MobileBotAvatarSource }
}) {
  const t = useMobileTranslation()
  // Only Needs you and Waiting have a second line, the bot's question or what it waits on; In
  // progress's spinner is its live signal.
  const question =
    !stale && !snoozed && item.status === 'needs_you'
      ? item.question?.text
      : !snoozed && item.status === 'waiting'
        ? item.wait?.text
        : undefined
  const Check = checked ? CircleCheck : Circle
  return (
    <ListRow
      title={item.title}
      marker={formatBotItemNumber(item.number)}
      subtitle={owner ? undefined : question}
      subtitleLines={1}
      detail={owner ? <MobileBotItemOwnerLine owner={owner} line={question} /> : undefined}
      leading={
        checked === null ? (
          <MobileBotItemStatusIcon
            status={item.status}
            live={isBotItemLive(item)}
            stale={stale || snoozed}
          />
        ) : (
          <Check
            size={18}
            color={checked ? colors.textPrimary : colors.textMuted}
            strokeWidth={2}
          />
        )
      }
      accessory={
        <View style={styles.trailing}>
          {unseen ? <View style={styles.unseen} /> : null}
          <Text style={styles.age}>
            {snoozed && item.snoozedUntil !== null
              ? t('bots.items.snooze.rowUntil', 'until {{when}}', {
                  when: formatPhoneSnoozeTime(item.snoozedUntil, now)
                })
              : formatTimeAgo(botItemActivityAt(item, now), now)}
          </Text>
        </View>
      }
      disabled={disabled && checked === null}
      accessibilityRole={checked === null ? 'button' : 'checkbox'}
      accessibilityLabel={
        checked === null
          ? `${formatBotItemNumber(item.number)} ${item.title}, ${botItemStatusName(item.status, t)}`
          : t('bots.items.row.select', 'Select {{title}}', { title: item.title })
      }
      onPress={onPress}
      onLongPress={onLongPress}
    />
  )
}

/** In a group's list: the member a row is from, its face and name, then the row's own line. */
export function MobileBotItemOwnerLine({
  owner,
  line
}: {
  owner: { name: string; avatar: MobileBotAvatarSource }
  line?: string
}) {
  useMobileColorScheme()
  return (
    <View style={styles.owner}>
      <MobileBotAvatar avatar={owner.avatar} size={14} />
      <Text style={styles.ownerText} numberOfLines={1}>
        {line ? `${owner.name} · ${line}` : owner.name}
      </Text>
    </View>
  )
}

/** The floating bar while rows are checked: "N selected · Move to · ×". */
export function MobileBotItemSelectionBar({
  count,
  onMove,
  onClear
}: {
  count: number
  onMove: () => void
  onClear: () => void
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  return (
    <View style={styles.bar}>
      <Text style={styles.barCount}>
        {t('bots.items.selected', '{{count}} selected', { count })}
      </Text>
      <Pressable
        onPress={onMove}
        accessibilityRole="button"
        style={({ pressed }) => [styles.barMove, pressed && styles.pressed]}
      >
        <Text style={styles.barMoveText}>{t('bots.items.pill.moveTo', 'Move to')}</Text>
      </Pressable>
      <Pressable
        onPress={onClear}
        accessibilityRole="button"
        accessibilityLabel={t('bots.items.pill.clear', 'Clear selection')}
        hitSlop={8}
        style={({ pressed }) => [styles.barClear, pressed && styles.pressed]}
      >
        <X size={16} color={colors.textSecondary} strokeWidth={2.2} />
      </Pressable>
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  trailing: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  owner: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 2 },
  ownerText: { flexShrink: 1, fontSize: typography.metaSize, color: colors.textSecondary },
  age: { fontSize: typography.metaSize, color: colors.textMuted, fontVariant: ['tabular-nums'] },
  bar: {
    position: 'absolute',
    left: spacing.md,
    right: spacing.md,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingLeft: spacing.lg,
    paddingRight: spacing.sm,
    paddingVertical: spacing.sm,
    borderRadius: radii.floating,
    backgroundColor: colors.bgRaised,
    borderWidth: 1,
    borderColor: colors.borderSubtle
  },
  barCount: { flex: 1, fontSize: typography.bodySize, color: colors.textPrimary },
  barMove: {
    paddingHorizontal: spacing.md,
    minHeight: 32,
    justifyContent: 'center',
    borderRadius: radii.pill,
    backgroundColor: colors.textPrimary
  },
  barMoveText: { fontSize: typography.bodySize, fontWeight: '600', color: colors.bgBase },
  barClear: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: feedback.pressedOpacity },
  unseen: {
    width: 6,
    height: 6,
    borderRadius: radii.pill,
    backgroundColor: colors.textPrimary
  }
}))
