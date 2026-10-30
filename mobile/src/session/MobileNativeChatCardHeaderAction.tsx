import { Keyboard, Pressable, StyleSheet } from 'react-native'
import { ChevronDown, X } from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'

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
  const Icon = onCancel ? X : ChevronDown
  return (
    <Pressable
      accessibilityLabel={
        onCancel
          ? t('common.cancel', 'Cancel')
          : t('session.nativeChatCardHeaderAction.collapse', 'Collapse')
      }
      accessibilityState={onCancel ? undefined : { expanded: true }}
      hitSlop={8}
      style={styles.action}
      onPress={() => {
        if (onCancel) {
          void onCancel(prompt)
          return
        }
        // Why: a reply field hidden by the collapse must not keep the keyboard up.
        Keyboard.dismiss()
        onCollapse?.()
      }}
      disabled={disabled}
    >
      <Icon size={16} color={colors.textMuted} />
    </Pressable>
  )
}

const styles = StyleSheet.create({
  action: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' }
})
