import { useEffect } from 'react'
import { Text } from 'react-native'
import { colors } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'

const TOAST_MS = 4000

/** A short message over a phone-drawn tab; it goes after a few seconds or when tapped. */
export function MobileLocalBrowserToast({
  message,
  onDismiss
}: {
  message: string | null
  onDismiss: () => void
}): React.JSX.Element | null {
  useMobileColorScheme()
  useEffect(() => {
    if (message === null) {
      return
    }
    const timer = setTimeout(onDismiss, TOAST_MS)
    return () => clearTimeout(timer)
  }, [message, onDismiss])
  if (message === null) {
    return null
  }
  return (
    <Text style={styles.toast} onPress={onDismiss}>
      {message}
    </Text>
  )
}

const styles = themedStyleSheet(() => ({
  toast: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 48,
    padding: 12,
    color: colors.textPrimary,
    backgroundColor: colors.bgRaised
  }
}))
