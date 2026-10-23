import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { FlatList, StyleSheet, View } from 'react-native'

import { colors, radii, spacing } from '../theme/mobile-theme'
import { triggerSelection } from '../platform/haptics'
import { BottomDrawer } from './BottomDrawer'
import { PickerEmptyState, PickerSheetTitle } from './PickerModal'
import { LIST_LEADING_INSET, LIST_ROW_PADDING } from './ui/ListGroup'
import { ListRow } from './ui/ListRow'
import { BOTTOM_DRAWER_HIDE_DURATION_MS } from './bottom-drawer-constants'

type PickerListItem = { id: string; label: string; detail?: string }

type Props<T extends PickerListItem> = {
  visible: boolean
  title: string
  items: T[]
  selectedId: string
  onSelect: (item: T) => void
  onClose: () => void
  renderIcon?: (item: T) => ReactNode
  /** Shown in place of the rows when there is nothing to pick. */
  emptyMessage?: string
}

export function PickerListDrawer<T extends PickerListItem>({
  visible,
  title,
  items,
  selectedId,
  onSelect,
  onClose,
  renderIcon,
  emptyMessage
}: Props<T>) {
  const [closing, setClosing] = useState(false)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const drawerVisible = visible && !closing

  useEffect(() => {
    if (visible) {
      setClosing(false)
    }
    return () => {
      if (closeTimerRef.current) {
        clearTimeout(closeTimerRef.current)
        closeTimerRef.current = null
      }
    }
  }, [visible])

  const finishClose = useCallback(() => {
    setClosing(false)
    onClose()
  }, [onClose])

  const closeThenSelect = useCallback(
    (item: T) => {
      if (closeTimerRef.current) {
        clearTimeout(closeTimerRef.current)
      }
      setClosing(true)
      closeTimerRef.current = setTimeout(() => {
        closeTimerRef.current = null
        onClose()
        onSelect(item)
      }, BOTTOM_DRAWER_HIDE_DURATION_MS)
    },
    [onClose, onSelect]
  )

  return (
    <BottomDrawer
      visible={drawerVisible}
      onClose={finishClose}
      dragContentToDismiss={false}
      contentScrollable={false}
    >
      <PickerSheetTitle title={title} />
      {items.length === 0 ? (
        <PickerEmptyState message={emptyMessage} />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(item) => item.id}
          style={styles.group}
          keyboardShouldPersistTaps="handled"
          nestedScrollEnabled
          ItemSeparatorComponent={renderIcon ? PickerIconSeparator : PickerSeparator}
          renderItem={({ item }) => (
            <ListRow
              title={item.label}
              subtitle={item.detail}
              leading={renderIcon ? (renderIcon(item) ?? null) : undefined}
              selected={item.id === selectedId}
              onPress={() => {
                triggerSelection()
                closeThenSelect(item)
              }}
            />
          )}
        />
      )}
    </BottomDrawer>
  )
}

function PickerSeparator() {
  return <View style={styles.separator} />
}

function PickerIconSeparator() {
  return <View style={[styles.separator, styles.separatorIcon]} />
}

const styles = StyleSheet.create({
  // Why: the sheet already pads 12; the group adds 4 so rows sit 16 from the sheet edge.
  group: {
    marginHorizontal: spacing.xs,
    backgroundColor: colors.groupFill,
    borderRadius: radii.group,
    overflow: 'hidden',
    maxHeight: 460,
    flexGrow: 0
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.separator,
    marginLeft: LIST_ROW_PADDING
  },
  separatorIcon: { marginLeft: LIST_LEADING_INSET }
})
