import { useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { MessageSquare, Plus, Users } from 'lucide-react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { ActionSheetModal } from '../components/sheets/ActionSheetModal'
import { feedback, spacing } from '../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../theme/themed-styles'
import { useMobileColors } from '../theme/use-mobile-color-scheme'
import type { BotGroup } from '../../../src/shared/bots/bot-group'

/** A group's rooms as the session's old tab bar drew tabs: the room you're in, the count of rooms, and +
 *  for a new thread. The original room comes first, then each thread as the desktop opened them. */
export function MobileBotGroupRoomBar({
  group,
  threadId,
  createDisabled,
  onOpenRoom,
  onNewThread
}: {
  group: Pick<BotGroup, 'name' | 'threads'>
  threadId: string | undefined
  createDisabled: boolean
  onOpenRoom: (threadId: string | undefined) => void
  onNewThread: () => void
}) {
  const colors = useMobileColors()
  const styles = useThemedStyles(stylesSheet)
  const t = useMobileTranslation()
  const [listing, setListing] = useState(false)
  const newThread = t('bots.groups.newThreadTab', 'New thread')
  const rooms = [
    { id: undefined, label: group.name, icon: Users },
    ...(group.threads ?? []).map((thread) => ({
      id: thread.id,
      label: thread.title ?? newThread,
      icon: MessageSquare
    }))
  ]
  const listed = rooms.find((room) => room.id === threadId)
  // A thread just made shows before the read that lists it lands.
  const active = listed ?? { id: threadId, label: newThread, icon: MessageSquare }
  const ActiveIcon = active.icon
  const count = rooms.length + (listed ? 0 : 1)
  const countLabel = t('session.tabBar.tabCount', '{{count}} tabs', { count })
  return (
    <View style={styles.bar}>
      <View style={styles.tabCell}>
        <Pressable
          style={({ pressed }) => [styles.tabPress, pressed && styles.cellPressed]}
          onPress={() => setListing(true)}
          accessibilityRole="button"
          accessibilityLabel={active.label}
          accessibilityHint={t('session.tabBar.hint', 'Shows all tabs')}
        >
          <View style={styles.tabContent}>
            <ActiveIcon size={14} color={colors.textSecondary} />
            <Text style={styles.title} numberOfLines={1}>
              {active.label}
            </Text>
          </View>
        </Pressable>
      </View>
      <Pressable
        style={({ pressed }) => [styles.sideCell, pressed && styles.cellPressed]}
        onPress={() => setListing(true)}
        accessibilityRole="button"
        accessibilityLabel={countLabel}
        accessibilityHint={t('session.tabBar.hint', 'Shows all tabs')}
      >
        <View style={styles.countBox}>
          <Text style={styles.countText}>{count}</Text>
        </View>
      </Pressable>
      <Pressable
        style={({ pressed }) => [
          styles.sideCell,
          styles.lastCell,
          pressed && styles.cellPressed,
          createDisabled && styles.cellDisabled
        ]}
        disabled={createDisabled}
        onPress={onNewThread}
        accessibilityRole="button"
        accessibilityLabel={newThread}
        accessibilityState={{ disabled: createDisabled }}
      >
        <Plus size={18} color={colors.textPrimary} strokeWidth={2.2} />
      </Pressable>
      <ActionSheetModal
        visible={listing}
        title={group.name}
        actions={rooms.map((room) => ({
          id: room.id ?? 'room',
          label: room.label,
          icon: room.icon,
          checked: room.id === threadId,
          onPress: () => onOpenRoom(room.id)
        }))}
        onClose={() => setListing(false)}
      />
    </View>
  )
}

// The session's former tab strip: the room you're in raised, the count and + as square cells.
const stylesSheet = themedStyleSheet((colors) => ({
  bar: {
    height: 44,
    flexDirection: 'row',
    alignItems: 'stretch',
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle
  },
  tabCell: {
    flex: 1,
    minWidth: 0,
    backgroundColor: colors.bgRaised,
    borderBottomWidth: 2,
    borderBottomColor: colors.textSecondary,
    borderRightWidth: 1,
    borderRightColor: colors.borderSubtle,
    overflow: 'hidden'
  },
  tabPress: {
    flex: 1,
    justifyContent: 'center',
    paddingLeft: spacing.lg,
    paddingRight: spacing.sm
  },
  tabContent: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  title: {
    flexShrink: 1,
    minWidth: 0,
    fontSize: 14,
    fontWeight: '600',
    color: colors.textPrimary
  },
  sideCell: {
    width: 46,
    alignItems: 'center',
    justifyContent: 'center',
    borderRightWidth: 1,
    borderRightColor: colors.borderSubtle
  },
  lastCell: { borderRightWidth: 0 },
  cellPressed: { backgroundColor: colors.translucentFill },
  cellDisabled: { opacity: feedback.disabledOpacity },
  countBox: {
    minWidth: 19,
    height: 19,
    paddingHorizontal: 3,
    borderRadius: 6,
    borderWidth: 1.8,
    borderColor: colors.textPrimary,
    alignItems: 'center',
    justifyContent: 'center'
  },
  countText: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.textPrimary,
    fontVariant: ['tabular-nums']
  }
}))
