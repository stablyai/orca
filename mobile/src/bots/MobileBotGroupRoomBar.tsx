import { useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { MessageSquare, Plus, Users } from 'lucide-react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { ActionSheetModal } from '../components/sheets/ActionSheetModal'
import { sessionTabBarStyles as styles } from '../session/tabs/MobileSessionTabBar'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { BotGroup } from '../../../src/shared/bots/bot-group'

/** A group's rooms as the session tab bar draws tabs: the room you're in, the count of rooms, and +
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
  useMobileColorScheme()
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
