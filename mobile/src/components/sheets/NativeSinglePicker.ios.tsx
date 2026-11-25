import { useEffect, useRef, useState } from 'react'
import { View } from 'react-native'
import {
  BottomSheet,
  Button,
  Group,
  HStack,
  Host,
  Image,
  List,
  NavigationStack,
  RNHostView,
  Section,
  Spacer,
  Text,
  VStack,
  useNativeState
} from '@expo/ui/swift-ui'
import {
  accessibilityAddTraits,
  disabled,
  font,
  foregroundStyle,
  listStyle,
  navigationBarTitleDisplayMode,
  navigationTitle,
  presentationDetents,
  presentationDragIndicator,
  searchable as searchableModifier
} from '@expo/ui/swift-ui/modifiers'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import type { NativeSinglePickerProps } from './NativeSinglePicker'
import { filterPickerOptions, groupPickerSections } from './picker-options'

export type { NativeSinglePickerProps }

// More rows than a half-height sheet shows get the full-height detent too.
const HALF_SHEET_ROWS = 6

/** A SwiftUI sheet holding an inset-grouped list; the chosen row carries the checkmark. */
export function NativeSinglePicker<T extends string>({
  visible,
  title,
  sections,
  selected,
  onSelect,
  onClose,
  onAfterClose,
  searchable = false
}: NativeSinglePickerProps<T>) {
  const t = useMobileTranslation()
  const searchText = useNativeState('')
  const [query, setQuery] = useState('')
  const scheme = useMobileColorScheme()
  const visibleRef = useRef(visible)
  useEffect(() => {
    visibleRef.current = visible
  })
  const rows = sections.reduce((count, section) => count + section.options.length, 0)
  const shownSections = query
    ? groupPickerSections(
        filterPickerOptions(
          sections.flatMap((section) => section.options),
          query
        )
      )
    : sections

  return (
    <Host colorScheme={scheme} style={SHEET_HOST_STYLE} pointerEvents="none">
      <BottomSheet
        isPresented={visible}
        // A swipe or a tap outside; a pick has already closed through `onClose`.
        onIsPresentedChange={(presented) => {
          if (!presented && visibleRef.current) {
            onClose()
          }
        }}
        onDismiss={() => {
          searchText.value = ''
          setQuery('')
          onAfterClose?.()
        }}
      >
        <Group
          modifiers={[
            presentationDetents(
              searchable || rows > HALF_SHEET_ROWS ? ['medium', 'large'] : ['medium']
            ),
            presentationDragIndicator('visible')
          ]}
        >
          <NavigationStack>
            <List
              modifiers={[
                listStyle('insetGrouped'),
                navigationTitle(title),
                navigationBarTitleDisplayMode('inline'),
                ...(searchable
                  ? [
                      searchableModifier(searchText, {
                        placement: 'navigationBarDrawer',
                        prompt: t('automations.mobile.searchOptions', 'Search options'),
                        onChange: setQuery
                      })
                    ]
                  : [])
              ]}
            >
              {shownSections.map((section) => (
                <Section key={section.options[0]?.value} title={section.title}>
                  {section.options.map((option) => {
                    const isSelected = option.value === selected
                    return (
                      <Button
                        key={option.value}
                        onPress={() => {
                          onSelect(option.value)
                          onClose()
                        }}
                        modifiers={[
                          disabled(option.disabled === true),
                          ...(isSelected ? [accessibilityAddTraits(['isSelected'])] : [])
                        ]}
                      >
                        <HStack spacing={12}>
                          {option.renderIcon ? (
                            <RNHostView matchContents>
                              <View>{option.renderIcon(isSelected)}</View>
                            </RNHostView>
                          ) : null}
                          <VStack alignment="leading" spacing={2}>
                            <Text
                              modifiers={[foregroundStyle(option.disabled ? TERTIARY : PRIMARY)]}
                            >
                              {option.label}
                            </Text>
                            {option.subtitle ? (
                              <Text
                                modifiers={[
                                  font({ textStyle: 'subheadline' }),
                                  foregroundStyle(SECONDARY)
                                ]}
                              >
                                {option.subtitle}
                              </Text>
                            ) : null}
                          </VStack>
                          <Spacer />
                          {isSelected ? (
                            <Image
                              systemName="checkmark"
                              modifiers={[font({ textStyle: 'body', weight: 'semibold' })]}
                            />
                          ) : null}
                        </HStack>
                      </Button>
                    )
                  })}
                </Section>
              ))}
            </List>
          </NavigationStack>
        </Group>
      </BottomSheet>
    </Host>
  )
}

const SHEET_HOST_STYLE = { position: 'absolute' } as const
const PRIMARY = { type: 'hierarchical', style: 'primary' } as const
const SECONDARY = { type: 'hierarchical', style: 'secondary' } as const
const TERTIARY = { type: 'hierarchical', style: 'tertiary' } as const
