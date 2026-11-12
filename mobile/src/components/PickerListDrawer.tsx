import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { FlatList, StyleSheet, Text, View } from 'react-native'

import { colors, radii, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { BottomDrawer } from './bottom-drawer/BottomDrawer'
import { BOTTOM_DRAWER_HIDE_DURATION_MS } from './bottom-drawer/bottom-drawer-constants'
import { LIST_LEADING_INSET, LIST_ROW_PADDING, ListRow } from './list/ListGroup'
import { MobileSearchField } from './MobileSearchField'
import { SheetHeader } from './nav-bar/SheetHeader'

type PickerListItem = { id: string; label: string; detail?: string }

/** A single row needs no search. */
const PICKER_SEARCH_MIN_ITEMS = 2

type PickerListSearch<T> = {
  placeholder: string
  emptyLabel: string
  filter: (items: T[], query: string) => T[]
}

type Props<T extends PickerListItem> = {
  visible: boolean
  title: string
  items: T[]
  selectedId: string
  /** Overrides id equality, e.g. for rows whose id adds a host to the project id. */
  isSelected?: (item: T) => boolean
  onSelect: (item: T) => void
  onClose: () => void
  renderIcon?: (item: T) => ReactNode
  search?: PickerListSearch<T>
}

export function PickerListDrawer<T extends PickerListItem>({
  visible,
  title,
  items,
  selectedId,
  isSelected,
  onSelect,
  onClose,
  renderIcon,
  search
}: Props<T>) {
  const colorScheme = useMobileColorScheme()
  const [closing, setClosing] = useState(false)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [query, setQuery] = useState('')
  const drawerVisible = visible && !closing
  const searchable = search !== undefined && items.length >= PICKER_SEARCH_MIN_ITEMS
  const shownItems = useMemo(
    () => (searchable && query.trim() !== '' ? search.filter(items, query) : items),
    [items, query, search, searchable]
  )

  useEffect(() => {
    if (visible) {
      setClosing(false)
      setQuery('')
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
      {searchable ? (
        <MobileSearchField
          value={query}
          onChangeText={setQuery}
          placeholder={search.placeholder}
          style={styles.search}
        />
      ) : null}
      <FlatList
        data={shownItems}
        extraData={colorScheme}
        keyExtractor={(item) => item.id}
        style={styles.group}
        contentContainerStyle={shownItems.length === 0 ? styles.emptyContent : undefined}
        keyboardShouldPersistTaps="handled"
        nestedScrollEnabled
        ItemSeparatorComponent={renderIcon ? PickerIconSeparator : PickerSeparator}
        ListEmptyComponent={
          searchable && query.trim() !== '' ? (
            <Text style={styles.emptyText}>{search.emptyLabel}</Text>
          ) : undefined
        }
        renderItem={({ item }) => (
          <ListRow
            title={item.label}
            subtitle={item.detail || undefined}
            leading={renderIcon ? (renderIcon(item) ?? null) : undefined}
            selected={isSelected ? isSelected(item) : item.id === selectedId}
            onPress={() => closeThenSelect(item)}
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
  search: {
    marginBottom: spacing.sm
  },
  emptyContent: {
    minHeight: spacing.xl
  },
  emptyText: {
    fontSize: 15,
    color: colors.textSecondary,
    padding: LIST_ROW_PADDING
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
