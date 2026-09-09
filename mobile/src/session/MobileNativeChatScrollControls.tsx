import { Pressable } from 'react-native'
import { ArrowDown, List } from 'lucide-react-native'
import { colors, spacing } from '../theme/mobile-theme'
import { styles } from './mobile-native-chat-view-styles'

type Props = {
  /** Whether the list is pinned to the newest message (hides jump-to-latest). */
  atBottom: boolean
  /** Show the turn-jump button; the view gates this on the outline size. */
  canJumpToTurn: boolean
  onScrollToLatest: () => void
  onOpenOutline: () => void
}

/** The floating controls overlaid on the chat list: jump-to-latest and the
 *  turn-jump outline opener. The outline button sits above the jump-to-latest
 *  slot so the two never overlap. */
export function MobileNativeChatScrollControls({
  atBottom,
  canJumpToTurn,
  onScrollToLatest,
  onOpenOutline
}: Props): React.JSX.Element {
  return (
    <>
      {/* The scroll-to-top affordance now lives per-message (the up-arrow in
          each agent message's controls). */}
      {!atBottom ? (
        <Pressable
          accessibilityLabel="Scroll to latest"
          style={[styles.fab, styles.fabBottom]}
          onPress={onScrollToLatest}
        >
          <ArrowDown size={18} color={colors.textPrimary} strokeWidth={2.2} />
        </Pressable>
      ) : null}
      {canJumpToTurn ? (
        <Pressable
          accessibilityLabel="Jump to a turn"
          style={[styles.fab, { bottom: atBottom ? spacing.md : spacing.md + 46 }]}
          onPress={onOpenOutline}
        >
          <List size={18} color={colors.textPrimary} strokeWidth={2.2} />
        </Pressable>
      ) : null}
    </>
  )
}
