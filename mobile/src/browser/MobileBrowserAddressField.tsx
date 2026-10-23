import type { ReactNode } from 'react'
import { Platform, StyleSheet, Text, TextInput, View } from 'react-native'
import { colors, radii } from '../theme/mobile-theme'
import { browserAddressFieldStyles } from './browser-address-field-styles'
import { compactMobileBrowserFileAddress } from './browser-url'
import { MobileBrowserLoadProgress } from './MobileBrowserLoadProgress'

type Props = {
  disabled: boolean
  focused: boolean
  loading: boolean
  loadFailed: boolean
  onBlur: () => void
  onChangeText: (value: string) => void
  onFocus: () => void
  onSubmit: () => void
  value: string
  /** Drawn inside the field's right end, e.g. the reload button. */
  trailing?: ReactNode
}

export function MobileBrowserAddressField({
  disabled,
  focused,
  loading,
  loadFailed,
  onBlur,
  onChangeText,
  onFocus,
  onSubmit,
  value,
  trailing
}: Props): React.JSX.Element {
  const fileLabel = focused ? null : compactMobileBrowserFileAddress(value)
  const selection = focused ? undefined : { start: 0, end: 0 }

  return (
    <View style={[styles.field, focused && styles.fieldFocused, disabled && styles.fieldDisabled]}>
      <View style={styles.inputSlot}>
        <TextInput
          style={browserAddressFieldStyles.input}
          value={value}
          onChangeText={onChangeText}
          onFocus={onFocus}
          onBlur={onBlur}
          onSubmitEditing={onSubmit}
          selectTextOnFocus
          selection={selection}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType={Platform.OS === 'ios' ? 'url' : 'default'}
          // Why: `keyboardType` is a native-only enum, so in a browser the URL keyboard is lost and
          // the field falls back to a plain one. `inputMode` is what a browser reads, and it takes
          // precedence over `keyboardType`, so it must stay undefined everywhere else.
          inputMode={Platform.OS === 'web' ? 'url' : undefined}
          numberOfLines={1}
          returnKeyType="go"
          placeholder="Enter address"
          selectionColor={colors.accentBlue}
          accessibilityLabel="Address"
          placeholderTextColor={colors.textMuted}
          editable={!disabled}
        />
        {fileLabel ? (
          <View pointerEvents="none" style={styles.fileLabelHost}>
            <Text
              style={browserAddressFieldStyles.fileLabel}
              numberOfLines={1}
              ellipsizeMode="middle"
            >
              {fileLabel}
            </Text>
          </View>
        ) : null}
      </View>
      {trailing}
      <MobileBrowserLoadProgress loading={loading} failed={loadFailed} />
    </View>
  )
}

const styles = StyleSheet.create({
  // Opaque, so the file label painted over the input hides the text under it.
  field: {
    flex: 1,
    minWidth: 0,
    height: 40,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.fieldBorder,
    backgroundColor: colors.bgPanel
  },
  fieldFocused: { borderColor: colors.fieldBorderFocused },
  fieldDisabled: { opacity: 0.6 },
  inputSlot: { flex: 1, minWidth: 0, alignSelf: 'stretch', flexDirection: 'row' },
  fileLabelHost: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    paddingHorizontal: 14,
    borderTopLeftRadius: radii.pill,
    borderBottomLeftRadius: radii.pill,
    backgroundColor: colors.bgPanel
  }
})
