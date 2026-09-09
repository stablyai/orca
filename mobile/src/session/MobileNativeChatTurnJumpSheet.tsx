import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native'
import { colors, spacing, typography } from '../theme/mobile-theme'
import { BottomDrawer } from '../components/BottomDrawer'
import type { MobileNativeChatOutlineItem } from './mobile-native-chat-render-data'

type Props = {
  visible: boolean
  onClose: () => void
  items: MobileNativeChatOutlineItem[]
  /** Jump the list to a `data` index; the view maps it onto its FlatList. */
  onJump: (index: number) => void
}

/** Conversation outline: the user turns of the thread, tap one to jump. Lets a
 *  long thread be navigated by turn instead of dragging through every message. */
export function MobileNativeChatTurnJumpSheet({ visible, onClose, items, onJump }: Props) {
  return (
    <BottomDrawer visible={visible} onClose={onClose} dragContentToDismiss={false}>
      <View style={styles.header}>
        <Text style={styles.title}>Jump to turn</Text>
      </View>
      <FlatList
        data={items}
        keyExtractor={(item) => String(item.index)}
        style={styles.list}
        contentContainerStyle={items.length === 0 ? styles.emptyContent : undefined}
        keyboardShouldPersistTaps="handled"
        nestedScrollEnabled
        ItemSeparatorComponent={TurnSeparator}
        ListEmptyComponent={<Text style={styles.empty}>No turns to jump to yet.</Text>}
        renderItem={({ item, index }) => (
          <Pressable
            style={({ pressed }) => [styles.item, pressed && styles.itemPressed]}
            accessibilityLabel={`Jump to turn ${index + 1}`}
            onPress={() => {
              onClose()
              onJump(item.index)
            }}
          >
            <Text style={styles.ordinal}>{index + 1}</Text>
            <View style={styles.copy}>
              <Text style={styles.itemTitle} numberOfLines={2}>
                {item.title}
              </Text>
              {item.subtitle ? (
                <Text style={styles.itemSubtitle} numberOfLines={2}>
                  {item.subtitle}
                </Text>
              ) : null}
            </View>
          </Pressable>
        )}
      />
    </BottomDrawer>
  )
}

function TurnSeparator() {
  return <View style={styles.separator} />
}

const styles = StyleSheet.create({
  header: {
    paddingHorizontal: spacing.xs,
    paddingBottom: spacing.sm
  },
  title: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.textMuted
  },
  list: {
    backgroundColor: colors.bgPanel,
    borderRadius: 12,
    overflow: 'hidden',
    maxHeight: 460,
    flexGrow: 0
  },
  emptyContent: {
    minHeight: spacing.xl,
    justifyContent: 'center'
  },
  empty: {
    color: colors.textMuted,
    fontSize: typography.metaSize,
    textAlign: 'center',
    paddingVertical: spacing.md
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
    marginHorizontal: spacing.md
  },
  item: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md
  },
  itemPressed: {
    backgroundColor: colors.bgRaised
  },
  ordinal: {
    color: colors.textMuted,
    fontSize: typography.metaSize,
    fontWeight: '700',
    minWidth: 18,
    textAlign: 'right',
    // Nudge the ordinal onto the title's first-line baseline.
    marginTop: 1
  },
  copy: {
    flex: 1,
    minWidth: 0
  },
  itemTitle: {
    fontSize: typography.bodySize,
    color: colors.textPrimary,
    fontWeight: '600'
  },
  itemSubtitle: {
    fontSize: typography.metaSize,
    color: colors.textMuted,
    marginTop: 2
  }
})
