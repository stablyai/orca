import { Keyboard, Platform, Pressable, StyleSheet } from 'react-native'
import { useEffect, useState } from 'react'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Search, X } from 'lucide-react-native'
import { colors, spacing } from '../theme/mobile-theme'
import { resolveBottomDrawerKeyboardInset } from './bottom-drawer-keyboard-inset'
import { FAB_SIZE } from './NewWorkspaceFab'

type SearchWorkspacesFabProps = {
  active: boolean
  onPress: () => void
}

// Phone search toggle paired with the new-workspace FAB.
export function SearchWorkspacesFab({
  active,
  onPress
}: SearchWorkspacesFabProps): React.JSX.Element {
  const insets = useSafeAreaInsets()
  const [keyboardHeight, setKeyboardHeight] = useState(0)

  useEffect(() => {
    // Why: iOS fires willShow before the animation, so the FAB rides the keyboard up instead of popping in late.
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow'
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide'
    const showSubscription = Keyboard.addListener(showEvent, ({ endCoordinates }) => {
      setKeyboardHeight(endCoordinates.height)
    })
    const hideSubscription = Keyboard.addListener(hideEvent, () => setKeyboardHeight(0))
    return () => {
      showSubscription.remove()
      hideSubscription.remove()
    }
  }, [])

  // Why: the FAB already offsets by insets.bottom, which the iOS keyboard frame also covers.
  const keyboardLift = resolveBottomDrawerKeyboardInset({
    keyboardHeight,
    bottomInset: insets.bottom,
    fillAvailable: false,
    platform: Platform.OS
  })

  return (
    <Pressable
      style={({ pressed }) => [
        styles.fab,
        { bottom: spacing.xl + insets.bottom + keyboardLift },
        pressed && styles.fabPressed
      ]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={active ? 'Close search' : 'Search workspaces'}
      hitSlop={8}
    >
      {active ? (
        <X size={22} color={colors.bgBase} strokeWidth={2.25} />
      ) : (
        <Search size={22} color={colors.bgBase} strokeWidth={2.25} />
      )}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  fab: {
    position: 'absolute',
    left: spacing.lg,
    width: FAB_SIZE,
    height: FAB_SIZE,
    borderRadius: FAB_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceBright,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3
  },
  fabPressed: {
    backgroundColor: colors.textPrimary
  }
})
