import { Platform, StyleSheet, Text, TextInput, View } from 'react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors, radii, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
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
  value
}: Props): React.JSX.Element {
  const t = useMobileTranslation()
  useMobileColorScheme()
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
        // Browser reads inputMode, not native keyboardType; keep it undefined on native where it would override URL keyboard.
        inputMode={Platform.OS === 'web' ? 'url' : undefined}
        numberOfLines={1}
        returnKeyType="go"
        placeholder={t('browser.addressField.urlPlaceholder', 'URL')}
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
      <MobileBrowserLoadProgress loading={loading} failed={loadFailed} />
    </View>
  )
}

const styles = themedStyleSheet(() => ({
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
}))
