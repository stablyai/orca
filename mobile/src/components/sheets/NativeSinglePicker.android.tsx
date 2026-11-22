import { useEffect, useRef, useState } from 'react'
import { View } from 'react-native'
import {
  AlertDialog,
  Column,
  Host,
  RadioButton,
  RNHostView,
  Row,
  Text,
  TextButton,
  TextField
} from '@expo/ui/jetpack-compose'
import {
  alpha,
  fillMaxWidth,
  padding,
  selectable,
  selectableGroup,
  verticalScroll,
  weight
} from '@expo/ui/jetpack-compose/modifiers'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import type { NativeSinglePickerProps } from './NativeSinglePicker'
import { DIALOG_HOST_STYLE, DIALOG_TITLE_STYLE } from './native-dialog-host'
import { filterPickerOptions, groupPickerSections } from './picker-options'

export type { NativeSinglePickerProps }

// Material 3's disabled content opacity.
const DISABLED_ALPHA = 0.38

/** A Material 3 single-choice dialog: radio rows that commit on tap, and Cancel. */
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
  const scheme = useMobileColorScheme()
  const afterClose = useRef(onAfterClose)
  const wasVisible = useRef(visible)
  useEffect(() => {
    afterClose.current = onAfterClose
  })
  useEffect(() => {
    if (wasVisible.current && !visible) {
      afterClose.current?.()
    }
    wasVisible.current = visible
  }, [visible])
  const [query, setQuery] = useState('')
  // The native field forgets its text when hidden, so a parent-side close must forget the query too.
  if (!visible && query !== '') {
    setQuery('')
  }
  const close = () => {
    setQuery('')
    onClose()
  }
  const shownSections = query
    ? groupPickerSections(
        filterPickerOptions(
          sections.flatMap((section) => section.options),
          query
        )
      )
    : sections

  if (!visible) {
    return null
  }
  return (
    <Host matchContents colorScheme={scheme} style={DIALOG_HOST_STYLE}>
      <AlertDialog onDismissRequest={close}>
        <AlertDialog.Title>
          <Text style={DIALOG_TITLE_STYLE}>{title}</Text>
        </AlertDialog.Title>
        <AlertDialog.Text>
          <Column verticalArrangement={{ spacedBy: 8 }}>
            {searchable ? (
              <TextField
                onValueChange={setQuery}
                singleLine
                keyboardOptions={{ capitalization: 'none', autoCorrectEnabled: false }}
                modifiers={[fillMaxWidth()]}
              >
                <TextField.Placeholder>
                  <Text>{t('automations.mobile.searchOptions', 'Search options')}</Text>
                </TextField.Placeholder>
              </TextField>
            ) : null}
            <Column modifiers={[selectableGroup(), verticalScroll()]}>
              {shownSections.map((section) => (
                <Column key={section.options[0]?.value}>
                  {section.title !== undefined ? (
                    <Text style={{ typography: 'labelLarge' }} modifiers={[padding(0, 12, 0, 4)]}>
                      {section.title}
                    </Text>
                  ) : null}
                  {section.options.map((option) => {
                    const isSelected = option.value === selected
                    const pick = () => {
                      onSelect(option.value)
                      close()
                    }
                    return (
                      <Row
                        key={option.value}
                        verticalAlignment="center"
                        horizontalArrangement={{ spacedBy: 12 }}
                        modifiers={[
                          fillMaxWidth(),
                          ...(option.disabled ? [] : [selectable(isSelected, pick, 'radioButton')]),
                          padding(0, 4, 0, 4)
                        ]}
                      >
                        <RadioButton selected={isSelected} enabled={!option.disabled} />
                        {option.renderIcon ? (
                          <RNHostView matchContents>
                            <View>{option.renderIcon(isSelected)}</View>
                          </RNHostView>
                        ) : null}
                        <Column
                          modifiers={[
                            weight(1),
                            ...(option.disabled ? [alpha(DISABLED_ALPHA)] : [])
                          ]}
                        >
                          <Text style={{ typography: 'bodyLarge' }}>{option.label}</Text>
                          {option.subtitle ? (
                            <Text style={{ typography: 'bodyMedium' }}>{option.subtitle}</Text>
                          ) : null}
                        </Column>
                      </Row>
                    )
                  })}
                </Column>
              ))}
            </Column>
          </Column>
        </AlertDialog.Text>
        <AlertDialog.ConfirmButton>
          <TextButton onClick={close}>
            <Text>{t('common.cancel', 'Cancel')}</Text>
          </TextButton>
        </AlertDialog.ConfirmButton>
      </AlertDialog>
    </Host>
  )
}
