import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useShellSideRail } from '../../../layout/use-shell-side-rail'
import { useReleasedSideInset } from '../../../layout/released-side-inset'
import { toggleDuoChatExpanded, useDuoChatExpanded } from '../../duo-chat-width'

export type ChatWidthToggle = { expanded: boolean; onToggle: () => void }

/**
 * Beside the Duo's status column the composer sits at the bottom edge, fitted to the screen
 * corners, and offers to keep the chat clear of the column.
 */
export function useChatBottomFit(keyboardInset: number): {
  bottomPad: number
  fitScreenCorners: boolean
  widthToggle: ChatWidthToggle | null
} {
  const insets = useSafeAreaInsets()
  const sideRail = useShellSideRail()
  const released = useReleasedSideInset()
  const expanded = useDuoChatExpanded()
  const bottomInset = sideRail ? 0 : insets.bottom
  return {
    bottomPad: keyboardInset > 0 ? keyboardInset + bottomInset : bottomInset,
    fitScreenCorners: sideRail && keyboardInset === 0,
    widthToggle: released ? { expanded, onToggle: toggleDuoChatExpanded } : null
  }
}
