import { useCallback, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { ChevronRight } from 'lucide-react-native'
import { nativeChatReasoningDisclosureKey } from '../../../src/shared/native-chat-reasoning-row'
import { formatNativeChatActiveTurnLabel } from '../../../src/shared/native-chat-turn-status'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { INLINE_TEXT_SELECTION } from '../components/inline-text-selection'
import { colors, spacing, typography } from '../theme/mobile-theme'
import { MobileNativeChatMessageActionsSheet } from './MobileNativeChatMessageActionsSheet'
import { MobileNativeChatReasoningBody } from './MobileNativeChatReasoningRow'
import type { MobileNativeChatLiveLine as LiveLine } from './use-mobile-native-chat-turn-disclosure'

/** The live turn's tail line: a spinner beside what the provider says it is doing, else
 *  "Thinking", else "Working…". The clock stays in the turn bar. While the agent's open reasoning
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
  // It holds the block it opened for, so it outlives that block ending and never reopens by itself.
  const [actionsFor, setActionsFor] = useState<NativeChatMessage | null>(null)
  const liveMessage = reasoning?.message ?? null
  const openActions = useCallback(() => setActionsFor(liveMessage), [liveMessage])
  return (
    <View>
      {/* One element for every state of the line, so TalkBack hears each new label; the body
          sits outside it. */}
      <Pressable
        style={({ pressed }) => [styles.row, reasoning && pressed && styles.pressed]}
        onPress={
          reasoning
            ? () => onToggleReasoning(nativeChatReasoningDisclosureKey(reasoning.message.id))
            : undefined
        }
        // With the row's 32 pt height, the 44 pt target the reasoning row has.
        hitSlop={6}
        accessibilityRole={reasoning ? 'button' : undefined}
        accessibilityState={reasoning ? { expanded: open } : undefined}
        accessibilityLabel={label}
        accessibilityLiveRegion="polite"
      >
        <View style={styles.glyph}>
          <ActivityIndicator size="small" color={colors.textMuted} />
        </View>
        <Text style={styles.label} numberOfLines={1}>
          {label}
        </Text>
        {reasoning ? (
          <View style={open ? styles.caretOpen : undefined}>
            <ChevronRight size={14} color={colors.textMuted} strokeWidth={2} />
          </View>
        ) : null}
      </Pressable>
      {reasoning && open ? (
        <View style={styles.body}>
          <MobileNativeChatReasoningBody
            markdown={reasoning.markdown}
            fontScale={fontScale}
            onOpenFile={onOpenFile}
            onLongPress={INLINE_TEXT_SELECTION ? undefined : openActions}
          />
        </View>
      ) : null}
      {actionsFor ? (
        <MobileNativeChatMessageActionsSheet
          message={actionsFor}
          onClose={() => setActionsFor(null)}
        />
      ) : null}
    </View>
  )
}

// The finished reasoning row's geometry (row gutter, 15 pt glyph slot, its gap, its 32 pt height),
// so the label and the open text do not move when that row takes over.
const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 32,
    paddingHorizontal: spacing.lg
  },
  // The spinner is wider than the brain; centred in the brain's slot it keeps the text column.
  glyph: {
    width: 15,
    alignItems: 'center',
    overflow: 'visible'
  },
  pressed: {
    opacity: 0.6
  },
  label: {
    color: colors.textMuted,
    fontSize: typography.bodySize,
    flexShrink: 1
  },
  caretOpen: {
    transform: [{ rotate: '90deg' }]
  },
  body: {
    paddingHorizontal: spacing.lg
  }
})
