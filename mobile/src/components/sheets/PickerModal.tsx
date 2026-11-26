import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useState, type ReactNode } from 'react'
import { View, Text } from 'react-native'
import { colors, spacing, typography } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { BottomDrawer } from '../bottom-drawer/BottomDrawer'
import {
  LIST_LEADING_INSET,
  LIST_ROW_PADDING,
  ListGroup,
  ListRow,
  SectionHeader
} from '../list/ListGroup'
import { MobileSearchField } from '../controls/MobileSearchField'

export type PickerOption<T extends string = string> = {
  value: T
  label: string
  subtitle?: string
  disabled?: boolean
  renderIcon?: (selected: boolean) => ReactNode
  /** Options sharing a section are grouped under its header, in the order they appear. */
  section?: string
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
  const hasIcons = visibleOptions.some((opt) => opt.renderIcon !== undefined)
  const sections: { title: string | undefined; options: PickerOption<T>[] }[] = []
  for (const opt of visibleOptions) {
    const last = sections.at(-1)
    if (last && last.title === opt.section) {
      last.options.push(opt)
    } else {
      sections.push({ title: opt.section, options: [opt] })
    }
  }
  return (
    <View style={styles.content}>
      {searchable ? (
        <MobileSearchField
          value={query}
          onChangeText={setQuery}
          placeholder={t('automations.mobile.searchOptions', 'Search options')}
        />
      ) : null}
      {sections.map((section, index) => (
        <View key={section.options[0]?.value}>
          {section.title !== undefined ? (
            <SectionHeader title={section.title} first={index === 0} />
          ) : null}
          <ListGroup separatorInset={hasIcons ? LIST_LEADING_INSET : LIST_ROW_PADDING}>
            {section.options.map((opt) => {
              const isSelected = opt.value === selected
              return (
                <ListRow
                  key={opt.value}
                  title={opt.label}
                  subtitle={opt.subtitle}
                  leading={opt.renderIcon?.(isSelected)}
                  selected={isSelected}
                  disabled={opt.disabled}
                  accessibilityRole="button"
                  onPress={() => {
                    onSelect(opt.value)
                    onClose()
                  }}
                  onLongPress={
                    onLongSelect
                      ? () => {
                          onLongSelect(opt.value)
                          onClose()
                        }
                      : undefined
                  }
                />
              )
            })}
          </ListGroup>
        </View>
      ))}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  header: {
    paddingHorizontal: LIST_ROW_PADDING,
    paddingBottom: spacing.sm
  },
  title: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.textSecondary
  },
  subtitle: {
    fontSize: typography.metaSize,
    color: colors.textMuted,
    marginTop: 2
  },
  content: {
    gap: spacing.sm
  }
}))
