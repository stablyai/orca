import { Platform, StyleSheet, Text, TextInput, View } from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
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
        style={styles.input}
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
        numberOfLines={1}
        returnKeyType="go"
        placeholder="URL"
        placeholderTextColor={colors.textMuted}
        editable={!disabled}
      />
      {fileLabel ? (
        <View pointerEvents="none" style={styles.fileLabelHost}>
          <Text style={styles.fileLabel} numberOfLines={1} ellipsizeMode="middle">
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
  input: {
    flex: 1,
    minWidth: 0,
    borderRadius: radii.input,
    backgroundColor: colors.bgRaised,
    color: colors.textPrimary,
    paddingHorizontal: spacing.sm,
    paddingVertical: 0,
    fontSize: 12,
    lineHeight: 16,
    includeFontPadding: false,
    textAlignVertical: 'center',
    fontFamily: typography.monoFamily
  },
  fileLabelHost: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
    borderRadius: radii.input,
    backgroundColor: colors.bgRaised
  },
  fileLabel: {
    color: colors.textPrimary,
    fontSize: 12,
    lineHeight: 16,
    fontFamily: typography.monoFamily
  }
})
