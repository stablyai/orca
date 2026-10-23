import type { ReactNode } from 'react'
import { View, Text, StyleSheet } from 'react-native'
import { colors, spacing, textStyles } from '../theme/mobile-theme'
import { triggerSelection } from '../platform/haptics'
import { BottomDrawer } from './BottomDrawer'
import { ListGroup, LIST_LEADING_INSET } from './ui/ListGroup'
import { ListRow } from './ui/ListRow'
import { SheetHeader } from './ui/SheetHeader'

export type PickerOption<T extends string = string> = {
  value: T
  label: string
  subtitle?: string
  disabled?: boolean
  renderIcon?: (selected: boolean) => ReactNode
}

type Props<T extends string = string> = {
  visible: boolean
  title: string
  subtitle?: string
  options: PickerOption<T>[]
  selected: T
  onSelect: (value: T) => void
  onLongSelect?: (value: T) => void
  onClose: () => void
  onAfterClose?: () => void
  zIndex?: number
  /** Shown in place of the rows when there is nothing to pick. */
  emptyMessage?: string
}

type PickerModalContentProps<T extends string = string> = Pick<
  Props<T>,
  'options' | 'selected' | 'onSelect' | 'onLongSelect' | 'onClose' | 'emptyMessage'
>

export function PickerModal<T extends string = string>({
  visible,
  title,
  subtitle,
  options,
  selected,
  onSelect,
  onLongSelect,
  onClose,
  onAfterClose,
  zIndex,
  emptyMessage
}: Props<T>) {
  return (
    <BottomDrawer visible={visible} onClose={onClose} onAfterClose={onAfterClose} zIndex={zIndex}>
      <PickerSheetTitle title={title} subtitle={subtitle} />
      <PickerModalContent
        options={options}
        selected={selected}
        onSelect={onSelect}
        onLongSelect={onLongSelect}
        onClose={onClose}
        emptyMessage={emptyMessage}
      />
    </BottomDrawer>
  )
}

/** The picker's question as the sheet's title; a pure list sheet, so no Cancel or Done. */
export function PickerSheetTitle({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <View style={styles.header}>
      <SheetHeader title={title} subtitle={subtitle} />
    </View>
  )
}

export function PickerEmptyState({ message }: { message?: string }) {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyText}>{message ?? 'Nothing to choose from yet.'}</Text>
    </View>
  )
}

function PickerModalContent<T extends string = string>({
  options,
  selected,
  onSelect,
  onLongSelect,
  onClose,
  emptyMessage
}: PickerModalContentProps<T>) {
  // Why: closed BottomDrawer instances return null, so keeping option rows in
  // this child avoids rebuilding hidden picker contents on every parent render.
  if (options.length === 0) {
    return <PickerEmptyState message={emptyMessage} />
  }
  // One icon column for the whole list, so labels line up even where an option has no icon.
  const hasIcons = options.some((opt) => opt.renderIcon !== undefined)
  return (
    <ListGroup separatorInset={hasIcons ? LIST_LEADING_INSET : undefined} style={styles.group}>
      {options.map((opt) => {
        const isSelected = opt.value === selected
        return (
          <ListRow
            key={opt.value}
            title={opt.label}
            subtitle={opt.subtitle}
            subtitleNumberOfLines={2}
            leading={hasIcons ? (opt.renderIcon?.(isSelected) ?? null) : undefined}
            selected={isSelected}
            disabled={opt.disabled}
            onPress={() => {
              if (opt.disabled) {
                return
              }
              triggerSelection()
              onSelect(opt.value)
              onClose()
            }}
            onLongPress={
              onLongSelect
                ? () => {
                    if (opt.disabled) {
                      return
                    }
                    onLongSelect(opt.value)
                    onClose()
                  }
                : undefined
            }
          />
        )
      })}
    </ListGroup>
  )
}

const styles = StyleSheet.create({
  header: { marginHorizontal: -spacing.sm, marginTop: -spacing.xs, marginBottom: spacing.xs },
  // Why: the sheet already pads 12; the group adds 4 so rows sit 16 from the sheet edge.
  group: { marginHorizontal: spacing.xs },
  empty: {
    marginHorizontal: spacing.xs,
    minHeight: 88,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl
  },
  emptyText: { ...textStyles.callout, color: colors.textSecondary, textAlign: 'center' }
})
