import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { FlatList, StyleSheet, Text, View } from 'react-native'

import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { colors, radii, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { BottomDrawer } from '../bottom-drawer/BottomDrawer'
import { BOTTOM_DRAWER_HIDE_DURATION_MS } from '../bottom-drawer/bottom-drawer-constants'
import { MobileSearchField } from '../controls/MobileSearchField'
import { LIST_LEADING_INSET, LIST_ROW_PADDING, ListRow } from '../list/ListGroup'
import { SheetHeader } from '../nav-bar/SheetHeader'
import { PICKER_SEARCH_MIN_ITEMS, filterPickerItems } from './picker-list-search'

type PickerListItem = { id: string; label: string; detail?: string }

type Props<T extends PickerListItem> = {
  visible: boolean
  title: string
  items: T[]
  selectedId: string
  onSelect: (item: T) => void
  onClose: () => void
  renderIcon?: (item: T) => ReactNode
  /** Shows a search field once the list is long enough to need one. */
  searchPlaceholder?: string
}

export function PickerListDrawer<T extends PickerListItem>({
  visible,
  title,
  items,
  selectedId,
  onSelect,
  onClose,
  renderIcon,
  searchPlaceholder
}: Props<T>) {
  const t = useMobileTranslation()
  const colorScheme = useMobileColorScheme()
  const [closing, setClosing] = useState(false)
  const [query, setQuery] = useState('')
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const drawerVisible = visible && !closing
  const wantsSearch = searchPlaceholder !== undefined && items.length >= PICKER_SEARCH_MIN_ITEMS
  // Why: settled as the sheet opens, so a list that loads in later does not resize it or add a field under the user.
  const [searchable, setSearchable] = useState(wantsSearch)
  const [wasVisible, setWasVisible] = useState(visible)
  if (visible !== wasVisible) {
    setWasVisible(visible)
    if (visible) {
      setSearchable(wantsSearch)
      setQuery('')
    }
  }
  const shownItems = useMemo(
    () => (searchable ? filterPickerItems(items, query) : items),
    [items, query, searchable]
  )

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
      // Why: a fixed-height sheet keeps the field above the keyboard while the list shrinks as you type.
      fillAvailable={searchable}
    >
      <View style={searchable ? styles.fillRoot : styles.flowRoot}>
        <View style={styles.header}>
          <SheetHeader title={title} />
        </View>
        {searchable && searchPlaceholder !== undefined ? (
          <View style={styles.search}>
            <MobileSearchField
              value={query}
              onChangeText={setQuery}
              placeholder={searchPlaceholder}
            />
          </View>
        ) : null}
        <FlatList
          data={shownItems}
          extraData={colorScheme}
          keyExtractor={(item) => item.id}
          style={[
            styles.group,
            searchable ? styles.groupFill : styles.groupBounded,
            searchable && shownItems.length === 0 && styles.groupEmpty
          ]}
          contentContainerStyle={shownItems.length === 0 ? styles.emptyContent : undefined}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={searchable ? 'on-drag' : undefined}
          nestedScrollEnabled
          ItemSeparatorComponent={renderIcon ? PickerIconSeparator : PickerSeparator}
          ListEmptyComponent={
            searchable ? (
              <Text style={styles.noMatches} accessibilityLiveRegion="polite">
                {t('components.pickerListDrawer.noMatches', 'No matches')}
              </Text>
            ) : undefined
          }
          renderItem={({ item }) => (
            <ListRow
              title={item.label}
              subtitle={item.detail || undefined}
              leading={renderIcon ? (renderIcon(item) ?? null) : undefined}
              selected={item.id === selectedId}
              onPress={() => closeThenSelect(item)}
            />
          )}
        />
      </View>
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
  fillRoot: {
    flex: 1,
    minHeight: 0
  },
  // Lets the list shrink to the sheet's cap as it did before the wrapper existed.
  flowRoot: {
    flexShrink: 1,
    minHeight: 0
  },
  header: {
    marginTop: -spacing.xs
  },
  search: {
    marginBottom: spacing.sm
  },
  group: {
    backgroundColor: colors.sheetGroup,
    borderRadius: radii.surface,
    overflow: 'hidden'
  },
  groupBounded: {
    maxHeight: 460,
    flexGrow: 0
  },
  // The sheet's height is fixed by fillRoot; the list only takes the rows it has.
  groupFill: {
    flexGrow: 0,
    flexShrink: 1,
    minHeight: 0
  },
  groupEmpty: {
    backgroundColor: 'transparent'
  },
  emptyContent: {
    minHeight: spacing.xl
  },
  noMatches: {
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.xl,
    textAlign: 'center',
    color: colors.textSecondary,
    fontSize: 13
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
