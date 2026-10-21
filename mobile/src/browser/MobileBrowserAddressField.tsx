import { Platform, StyleSheet, Text, TextInput, View } from 'react-native'
import { colors, radii, spacing } from '../theme/mobile-theme'
import { browserAddressFieldStyles } from './browser-address-field-styles'
import { compactMobileBrowserFileAddress } from './browser-url'

type Props = {
  disabled: boolean
  focused: boolean
  onBlur: () => void
  onChangeText: (value: string) => void
  onFocus: () => void
  onSubmit: () => void
  value: string
}

export function MobileBrowserAddressField({
  disabled,
  focused,
  onBlur,
  onChangeText,
  onFocus,
  onSubmit,
  value
}: Props): React.JSX.Element {
  const fileLabel = focused ? null : compactMobileBrowserFileAddress(value)
  const selection = focused ? undefined : { start: 0, end: 0 }

  return (
    <View style={styles.field}>
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
        placeholder="URL"
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
  )
}

const styles = StyleSheet.create({
  field: {
    flex: 1,
    minWidth: 0,
    height: 28
  },
  fileLabelHost: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
    borderRadius: radii.input,
    backgroundColor: colors.bgRaised
  }
})
