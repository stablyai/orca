import { Keyboard, Pressable, StyleSheet, View } from 'react-native'
import { ChevronDown, X } from '../../../../components/icons/app-icons'
import { colors, pressedStyle } from '../../../../theme/mobile-theme'
import { useMobileColorScheme } from '../../../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { MobilePendingButton } from '../../../../components/controls/MobilePendingButton'

/** Collapse and Cancel; a structured question offers both, so neither hides the other. */
export function MobileNativeChatCardHeaderAction<Prompt>({
  prompt,
  onCancel,
  onCollapse,
  disabled,
  cancelPending = false
}: {
  prompt?: Prompt
  onCancel?: (prompt?: Prompt) => Promise<boolean>
  onCollapse?: () => void
  disabled?: boolean
  /** This card's cancel is on its way. */
  cancelPending?: boolean
}): React.JSX.Element | null {
  useMobileColorScheme()
  const t = useMobileTranslation()
  if (!onCancel && !onCollapse) {
    return null
  }
  return (
    <View style={styles.row}>
      {onCollapse ? (
        <Pressable
          accessibilityLabel={t('session.nativeChatCardHeaderAction.collapse', 'Collapse')}
          accessibilityState={{ expanded: true }}
          hitSlop={8}
          style={({ pressed }) => [styles.action, pressed && pressedStyle]}
          onPress={() => {
            // Why: a reply field hidden by the collapse must not keep the keyboard up.
            Keyboard.dismiss()
            onCollapse()
          }}
          disabled={disabled}
        >
          <ChevronDown size={16} color={colors.textMuted} />
        </Pressable>
      ) : null}
      {onCancel ? (
        <MobilePendingButton
          label={t('common.cancel', 'Cancel')}
          iconOnly
          icon={<X size={16} color={colors.textMuted} />}
          pending={cancelPending}
          disabled={disabled}
          onPress={() => void onCancel(prompt)}
          hitSlop={8}
          style={styles.action}
          spinnerColor={colors.textMuted}
        />
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  // Centred on the card title's first line.
  row: { flexDirection: 'row', alignItems: 'center', marginTop: 7 },
  action: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' }
})
