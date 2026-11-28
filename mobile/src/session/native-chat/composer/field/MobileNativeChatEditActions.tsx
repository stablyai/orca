import { Pressable, Text } from 'react-native'
import { useMobileColors } from '../../../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { MobilePendingButton } from '../../../../components/controls/MobilePendingButton'
import {
  COMPOSER_CONTROL_HIT_SLOP,
  composerInputStylesSheet
} from '../../../../components/composer-input/composer-input-styles'
import { useThemedStyles } from '../../../../theme/themed-styles'

/** Cancel and Save for a queued message being edited, in Send's place. */
export function MobileNativeChatEditActions({
  canSave,
  saving,
  onCancel,
  onSave
}: {
  canSave: boolean
  /** The edit's save is on its way. */
  saving: boolean
  onCancel: () => void
  onSave: () => void
}): React.JSX.Element {
  const inputStyles = useThemedStyles(composerInputStylesSheet)
  const colors = useMobileColors()
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
      <MobilePendingButton
        label={t('common.save', 'Save')}
        accessibilityLabel={t('chat.composer.saveEditedMessage', 'Save edited message')}
        style={inputStyles.sendLabelButton}
        labelStyle={{ color: canSave ? colors.bgBase : colors.textMuted }}
        disabledStyle={inputStyles.sendButtonDisabled}
        spinnerColor={colors.bgBase}
        pending={saving}
        disabled={!canSave}
        onPress={onSave}
        hitSlop={COMPOSER_CONTROL_HIT_SLOP}
      />
    </>
  )
}
