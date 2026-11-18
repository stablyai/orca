import type { ReactNode } from 'react'
import { Modal, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { colors } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'

type Props = {
  onRequestClose: () => void
  children: ReactNode
}

/** Holds a browser tab over the whole screen, streamed or drawn on the phone. */
export function MobileBrowserFullScreenFrame({
  onRequestClose,
  children
}: Props): React.JSX.Element {
  useMobileColorScheme()
  const insets = useSafeAreaInsets()
  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={onRequestClose}
    >
      <View style={[styles.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        {children}
      </View>
    </Modal>
  )
}

const styles = themedStyleSheet(() => ({
  root: {
    flex: 1,
    backgroundColor: colors.bgBase
  }
}))
