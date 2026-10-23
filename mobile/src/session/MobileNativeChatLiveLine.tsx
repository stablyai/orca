import { useContext } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { nativeChatReasoningDisclosureKey } from '../../../src/shared/native-chat-reasoning-row'
import { formatNativeChatActiveTurnLabel } from '../../../src/shared/native-chat-turn-status'
import { INLINE_TEXT_SELECTION } from '../components/inline-text-selection'
import { LoadingSpinner } from '../components/LoadingSpinner'
import { Collapsible } from '../components/ui/Collapsible'
import { pressTransition } from '../components/ui/transition-styles'
import { colors, MIN_TOUCH_TARGET, spacing, textStyles } from '../theme/mobile-theme'
import { DISCLOSURE_BLEED, MobileNativeChatChevron } from './MobileNativeChatDisclosureRow'
import { scaledText } from './mobile-native-chat-message-styles'
import { MobileNativeChatReasoningBody } from './MobileNativeChatReasoningRow'
import { MobileNativeChatRowOverlaysContext } from './mobile-native-chat-row-overlays'
import type { MobileNativeChatLiveLine as LiveLine } from './use-mobile-native-chat-turn-disclosure'

/** The live turn's tail line: a spinner beside "Stopping…" once the person's Stop is ending the
 *  turn, else what the provider says it is doing, else "Thinking", else "Working…". The clock
 *  stays in the turn bar. While the agent's open reasoning
 *  block has text it is also that block's disclosure, and the block's row draws nothing.
 *  Desktop parity: `NativeChatTurnActivityLine`. */
export function MobileNativeChatLiveLine({
  line,
  onToggleReasoning,
  fontScale,
  onOpenFile
}: {
  line: LiveLine
  onToggleReasoning: (key: string) => void
  fontScale: number
  onOpenFile?: (relativePath: string) => void
}): React.JSX.Element {
  const { reasoning, reasoningExpanded } = line
  const open = reasoning !== null && reasoningExpanded
  const label = formatNativeChatActiveTurnLabel(line)
  // Android has no inline selection; the finished row's long-press sheet copies the live text too.
  const { openActions } = useContext(MobileNativeChatRowOverlaysContext)
  return (
    <View>
      {/* One element for every state of the line, so TalkBack hears each new label; the body
          sits outside it. */}
      <Pressable
        style={({ pressed }) => [
          styles.row,
          reasoning && pressed && styles.pressed,
          reasoning ? (pressed ? pressTransition.pressed : pressTransition.rest) : null
        ]}
        onPress={
          reasoning
            ? () => onToggleReasoning(nativeChatReasoningDisclosureKey(reasoning.message.id))
            : undefined
        }
        accessibilityRole={reasoning ? 'button' : undefined}
        accessibilityState={reasoning ? { expanded: open } : undefined}
        accessibilityLabel={label}
        accessibilityLiveRegion="polite"
      >
        <View style={[styles.glyph, { width: 16 * fontScale }]}>
          <LoadingSpinner size={16 * fontScale} color={colors.textSecondary} />
        </View>
        <Text style={[styles.label, scaledText(textStyles.callout, fontScale)]} numberOfLines={1}>
          {label}
        </Text>
        {reasoning ? <MobileNativeChatChevron open={open} fontScale={fontScale} /> : null}
      </Pressable>
      <Collapsible open={open}>
        {reasoning ? (
          <View style={styles.body}>
            <MobileNativeChatReasoningBody
              positionKey={nativeChatReasoningDisclosureKey(reasoning.message.id)}
              markdown={reasoning.markdown}
              fontScale={fontScale}
              onOpenFile={onOpenFile}
              onLongPress={INLINE_TEXT_SELECTION ? undefined : () => openActions(reasoning.message)}
            />
          </View>
        ) : null}
      </Collapsible>
    </View>
  )
}

// The finished reasoning row's geometry (row gutter, 16 pt glyph slot, its gap, 44 pt height), so
// the label and the open text do not move when that row takes over.
const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: MIN_TOUCH_TARGET,
    marginHorizontal: spacing.lg - DISCLOSURE_BLEED,
    paddingHorizontal: DISCLOSURE_BLEED,
    paddingVertical: 6,
    borderRadius: 12
  },
  // The spinner is wider than the brain; centred in the brain's slot it keeps the text column.
  glyph: {
    alignItems: 'center',
    overflow: 'visible'
  },
  pressed: {
    backgroundColor: colors.fill
  },
  label: {
    ...textStyles.callout,
    flex: 1,
    minWidth: 0,
    color: colors.textSecondary
  },
  body: {
    paddingHorizontal: spacing.lg
  }
})
