import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useShellSideRail } from '../../../layout/use-shell-side-rail'

/** Beside the Duo's status column the composer sits at the bottom edge, fitted to the screen corners. */
export function useChatBottomFit(keyboardInset: number): {
  bottomPad: number
  fitScreenCorners: boolean
} {
  const insets = useSafeAreaInsets()
  const sideRail = useShellSideRail()
  const bottomInset = sideRail ? 0 : insets.bottom
  return {
    bottomPad: keyboardInset > 0 ? keyboardInset + bottomInset : bottomInset,
    fitScreenCorners: sideRail && keyboardInset === 0
  }
}
