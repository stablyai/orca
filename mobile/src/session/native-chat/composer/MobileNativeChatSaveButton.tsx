import { Pressable, Text } from 'react-native'
import { colors } from '../../../theme/mobile-theme'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import {
  COMPOSER_CONTROL_HIT_SLOP,
  composerInputStyles as styles
} from '../../../components/composer-input/composer-input-styles'

export function MobileNativeChatSaveButton({
  canSave,
  onSave
}: {
  canSave: boolean
  onSave: () => void
}): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('chat.composer.saveEditedMessage', 'Save edited message')}
      style={({ pressed }) => [
        styles.sendButton,
        styles.textButton,
        !canSave && styles.sendButtonDisabled,
        pressed && canSave && styles.pressed
      ]}
      onPress={onSave}
      disabled={!canSave}
      hitSlop={COMPOSER_CONTROL_HIT_SLOP}
    >
      <Text style={[styles.textButtonLabel, { color: canSave ? colors.bgBase : colors.textMuted }]}>
        {t('common.save', 'Save')}
      </Text>
    </Pressable>
  )
}
