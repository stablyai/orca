import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useState, type ReactNode } from 'react'
import { View, Text, Pressable, StyleSheet } from 'react-native'
import { Check } from 'lucide-react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { BottomDrawer } from './BottomDrawer'
import { MobileSearchField } from './MobileSearchField'

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
  searchable?: boolean
}

type PickerModalContentProps<T extends string = string> = Pick<
  Props<T>,
  'options' | 'selected' | 'onSelect' | 'onLongSelect' | 'onClose' | 'searchable'
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
  searchable
}: Props<T>) {
  useMobileColorScheme()
  return (
    <BottomDrawer visible={visible} onClose={onClose} onAfterClose={onAfterClose} zIndex={zIndex}>
      <View style={styles.header}>
        <Text style={styles.title}>{title}</Text>
        {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
      </View>

      <PickerModalContent
        options={options}
        selected={selected}
        onSelect={onSelect}
        onLongSelect={onLongSelect}
        onClose={onClose}
        searchable={searchable}
      />
    </BottomDrawer>
  )
}

function PickerModalContent<T extends string = string>({
  options,
  selected,
  onSelect,
  onLongSelect,
  onClose,
  searchable
}: PickerModalContentProps<T>) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const [query, setQuery] = useState('')
  const visibleOptions = searchable
    ? options.filter((option) =>
        `${option.label} ${option.subtitle ?? ''}`
          .toLocaleLowerCase()
          .includes(query.trim().toLocaleLowerCase())
      )
    : options
  // Put option rows in shown child; closed BottomDrawer returns null, avoiding hidden-content rebuilds on parent renders.
  return (
    <View style={styles.group}>
      {searchable ? (
        <MobileSearchField
          value={query}
          onChangeText={setQuery}
          placeholder={t('automations.mobile.searchOptions', 'Search options')}
        />
      ) : null}
      {visibleOptions.map((opt, i) => {
        const isSelected = opt.value === selected
        return (
          <View key={opt.value}>
            {i > 0 && <View style={styles.separator} />}
            <Pressable
              accessible
              accessibilityRole="button"
              accessibilityState={{ disabled: Boolean(opt.disabled), selected: isSelected }}
              disabled={opt.disabled}
              style={({ pressed }) => [
                styles.row,
                pressed && !opt.disabled && styles.rowPressed,
                opt.disabled && styles.rowDisabled
              ]}
              onPress={() => {
                if (opt.disabled) {
                  return
                }
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
            >
              {opt.renderIcon ? (
                <View style={styles.rowIcon}>{opt.renderIcon(isSelected)}</View>
              ) : null}
              <View style={styles.rowContent}>
                <Text style={[styles.rowLabel, isSelected && styles.rowLabelSelected]}>
                  {opt.label}
                </Text>
                {opt.subtitle ? <Text style={styles.rowSubtitle}>{opt.subtitle}</Text> : null}
              </View>
              {isSelected && <Check size={16} color={colors.textPrimary} />}
            </Pressable>
          </View>
        )
      })}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  header: {
    paddingHorizontal: spacing.xs,
    paddingBottom: spacing.sm
  },
  title: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.textMuted
  },
  subtitle: {
    fontSize: 11,
    color: colors.textMuted,
    marginTop: 2
  },
  group: {
    backgroundColor: colors.sheetGroup,
    borderRadius: radii.surface,
    overflow: 'hidden'
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
    marginHorizontal: spacing.md
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md + 2
  },
  rowPressed: {
    backgroundColor: colors.borderSubtle
  },
  rowDisabled: {
    opacity: 0.45
  },
  rowContent: {
    flex: 1,
    minWidth: 0
  },
  rowIcon: {
    width: 22,
    alignItems: 'center',
    marginRight: spacing.sm
  },
  rowLabel: {
    fontSize: typography.bodySize,
    color: colors.textPrimary
  },
  rowLabelSelected: {
    fontWeight: '600'
  },
  rowSubtitle: {
    fontSize: 11,
    color: colors.textMuted,
    marginTop: 1
  }
}))
