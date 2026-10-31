import { Platform, StyleSheet, Text, View } from 'react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { TextField } from '../components/composer-input/TextField'
import {
  COMPOSER_TEXT_SIZE,
  composerInputStyles
} from '../components/composer-input/composer-input-styles'
import { compactMobileBrowserFileAddress } from './browser-url'
import { MobileBrowserLoadProgress } from './MobileBrowserLoadProgress'

// The browser toolbar is a 32pt strip of 15pt icons; a 44pt field would double its height.
const ADDRESS_FIELD_HEIGHT = 28

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
    <View style={styles.host}>
      <TextField
        style={styles.compact}
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
        editable={!disabled}
      />
      {fileLabel ? (
        <View
          pointerEvents="none"
          style={[composerInputStyles.field, styles.compact, styles.fileLabelHost]}
        >
          <Text style={styles.fileLabel} numberOfLines={1} ellipsizeMode="middle">
            {fileLabel}
          </Text>
        </View>
      ) : null}
      <MobileBrowserLoadProgress loading={loading} failed={loadFailed} />
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  host: {
    flex: 1,
    minWidth: 0
  },
  compact: {
    minHeight: ADDRESS_FIELD_HEIGHT,
    height: ADDRESS_FIELD_HEIGHT
  },
  fileLabelHost: {
    ...StyleSheet.absoluteFillObject
  },
  fileLabel: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: COMPOSER_TEXT_SIZE
  }
}))
