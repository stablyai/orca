import { Pressable, Text } from 'react-native'
import { colors } from '../../../theme/mobile-theme'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import {
  COMPOSER_CONTROL_HIT_SLOP,
  composerInputStyles as inputStyles
} from '../../../components/composer-input/composer-input-styles'

/** Cancel and Save for a queued message being edited, in Send's place. */
export function MobileNativeChatEditActions({
  canSave,
  onCancel,
  onSave
}: {
  canSave: boolean
  onCancel: () => void
  onSave: () => void
}): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('chat.composer.cancelEditing', 'Cancel editing')}
        style={({ pressed }) => [inputStyles.ghostLabelButton, pressed && inputStyles.pressed]}
        onPress={onCancel}
        hitSlop={COMPOSER_CONTROL_HIT_SLOP}
      >
        <Text style={{ color: colors.textSecondary }} numberOfLines={1}>
          {t('common.cancel', 'Cancel')}
        </Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: !canSave }}
        accessibilityLabel={t('chat.composer.saveEditedMessage', 'Save edited message')}
        style={({ pressed }) => [
          inputStyles.sendLabelButton,
          !canSave && inputStyles.sendButtonDisabled,
          pressed && canSave && inputStyles.pressed
        ]}
        onPress={onSave}
        disabled={!canSave}
        hitSlop={COMPOSER_CONTROL_HIT_SLOP}
      >
        <Text style={{ color: canSave ? colors.bgBase : colors.textMuted }} numberOfLines={1}>
          {t('common.save', 'Save')}
        </Text>
      </Pressable>
    </>
  )
}
