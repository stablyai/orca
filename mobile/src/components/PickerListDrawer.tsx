import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { FlatList, StyleSheet, View } from 'react-native'

import { triggerSelection } from '../platform/haptics'
import { colors, radii, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { BottomDrawer } from './BottomDrawer'
import { BOTTOM_DRAWER_HIDE_DURATION_MS } from './bottom-drawer-constants'
import { LIST_LEADING_INSET, LIST_ROW_PADDING } from './list/ListGroup'
import { ListRow } from './list/ListRow'
import { SheetHeader } from './nav-bar/SheetHeader'

type PickerListItem = { id: string; label: string; detail?: string }

type Props<T extends PickerListItem> = {
  visible: boolean
  title: string
  items: T[]
  selectedId: string
  onSelect: (item: T) => void
  onClose: () => void
  renderIcon?: (item: T) => ReactNode
}

export function PickerListDrawer<T extends PickerListItem>({
  visible,
  title,
  items,
  selectedId,
  onSelect,
  onClose,
  renderIcon
}: Props<T>) {
  const colorScheme = useMobileColorScheme()
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
      <View style={styles.header}>
        <SheetHeader title={title} />
      </View>
      <FlatList
        data={items}
        extraData={colorScheme}
        keyExtractor={(item) => item.id}
        style={styles.group}
        contentContainerStyle={items.length === 0 ? styles.emptyContent : undefined}
        keyboardShouldPersistTaps="handled"
        nestedScrollEnabled
        ItemSeparatorComponent={renderIcon ? PickerIconSeparator : PickerSeparator}
        renderItem={({ item }) => (
          <ListRow
            title={item.label}
            subtitle={item.detail || undefined}
            leading={renderIcon ? (renderIcon(item) ?? null) : undefined}
            selected={item.id === selectedId}
            onPress={() => {
              triggerSelection()
              closeThenSelect(item)
            }}
          />
        )}
      />
    </BottomDrawer>
  )
}

function PickerSeparator() {
  useMobileColorScheme()
  return <View style={styles.separator} />
}

function PickerIconSeparator() {
  useMobileColorScheme()
  return <View style={[styles.separator, styles.separatorIcon]} />
}

const styles = themedStyleSheet(() => ({
  header: {
    marginTop: -spacing.xs
  },
  group: {
    backgroundColor: colors.sheetGroup,
    borderRadius: radii.surface,
    overflow: 'hidden',
    maxHeight: 460,
    flexGrow: 0
  },
  emptyContent: {
    minHeight: spacing.xl
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
    marginLeft: LIST_ROW_PADDING
  },
  separatorIcon: {
    marginLeft: LIST_LEADING_INSET
  }
}))
