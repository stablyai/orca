import { Keyboard, Pressable, StyleSheet } from 'react-native'
import { ChevronDown, X } from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'

/** A prompt card's header action: Cancel where the lane can cancel, else a Collapse that writes nothing. */
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
  if (!onCancel && !onCollapse) {
    return null
  }
  const Icon = onCancel ? X : ChevronDown
  return (
    <Pressable
      accessibilityLabel={onCancel ? 'Cancel' : 'Collapse'}
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
