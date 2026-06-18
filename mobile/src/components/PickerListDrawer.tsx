import type { ReactNode } from 'react'
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native'
import { Check } from 'lucide-react-native'

import { colors, spacing, typography } from '../theme/mobile-theme'
import { BottomDrawer } from './BottomDrawer'

type Props<T extends { id: string; label: string }> = {
  visible: boolean
  title: string
  items: T[]
  selectedId: string
  onSelect: (item: T) => void
  onClose: () => void
  renderIcon?: (item: T) => ReactNode
}

export function PickerListDrawer<T extends { id: string; label: string }>({
  visible,
  title,
  items,
  selectedId,
  onSelect,
  onClose,
  renderIcon
}: Props<T>) {
  return (
    <BottomDrawer
      visible={visible}
      onClose={onClose}
      dragContentToDismiss={false}
      contentScrollable={false}
    >
      <View style={styles.header}>
        <Text style={styles.title}>{title}</Text>
      </View>
      <FlatList
        data={items}
        keyExtractor={(item) => item.id}
        style={styles.group}
        contentContainerStyle={items.length === 0 ? styles.emptyContent : undefined}
        keyboardShouldPersistTaps="handled"
        nestedScrollEnabled
        ItemSeparatorComponent={PickerSeparator}
        renderItem={({ item }) => {
          const selected = item.id === selectedId
          return (
            <Pressable
              style={({ pressed }) => [styles.item, pressed && styles.itemPressed]}
              onPress={() => {
                onClose()
                onSelect(item)
              }}
            >
              {renderIcon?.(item)}
              <Text
                style={[styles.itemText, selected && styles.itemTextSelected]}
                numberOfLines={1}
              >
                {item.label}
              </Text>
              {selected && <Check size={14} color={colors.textPrimary} />}
            </Pressable>
          )
        }}
      />
    </BottomDrawer>
  )
}

function PickerSeparator() {
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
  group: {
    backgroundColor: colors.bgPanel,
    borderRadius: 12,
    overflow: 'hidden',
    maxHeight: 420,
    flexGrow: 0
  },
  emptyContent: {
    minHeight: spacing.xl
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
    marginHorizontal: spacing.md
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md + 2
  },
  itemPressed: {
    backgroundColor: colors.bgRaised
  },
  itemText: {
    flex: 1,
    fontSize: typography.bodySize,
    color: colors.textPrimary
  },
  itemTextSelected: {
    fontWeight: '600'
  }
})
