import { Keyboard, Pressable, StyleSheet, View } from 'react-native'
import { ChevronDown, X } from 'lucide-react-native'
import { colors, pressedStyle } from '../../../../theme/mobile-theme'
import { useMobileColorScheme } from '../../../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'

/** Collapse and Cancel; a structured question offers both, so neither hides the other. */
export function MobileNativeChatCardHeaderAction<Prompt>({
  prompt,
  onCancel,
  onCollapse,
  disabled
}: {
  prompt?: Prompt
  onCancel?: (prompt?: Prompt) => Promise<boolean>
  onCollapse?: () => void
  disabled?: boolean
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
        <Pressable
          accessibilityLabel={t('common.cancel', 'Cancel')}
          hitSlop={8}
          style={({ pressed }) => [styles.action, pressed && pressedStyle]}
          onPress={() => void onCancel(prompt)}
          disabled={disabled}
        >
          <X size={16} color={colors.textMuted} />
        </Pressable>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  action: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' }
})
