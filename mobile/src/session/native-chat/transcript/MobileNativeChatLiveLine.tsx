import { useContext } from 'react'
import { Pressable, Text, View } from 'react-native'
import { ChevronRight } from 'lucide-react-native'
import { nativeChatReasoningDisclosureKey } from '../../../../../src/shared/native-chat-reasoning-row'
import { formatNativeChatActiveTurnLabel } from '../../../../../src/shared/native-chat-turn-status'
import { INLINE_TEXT_SELECTION } from '../../../components/inline-text-selection'
import { LoadingSpinner } from '../../../components/LoadingSpinner'
import { colors, spacing, typography } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { MobileNativeChatReasoningBody } from './MobileNativeChatReasoningRow'
import { MobileNativeChatRowOverlaysContext } from './mobile-native-chat-row-overlays'
import type { MobileNativeChatLiveLine as LiveLine } from './use-mobile-native-chat-turn-disclosure'

// Keep the clock in the turn bar; the live line may disclose reasoning whose standalone row is hidden.
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
  useMobileColorScheme()
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
          <LoadingSpinner size={15} color={colors.textMuted} />
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
            positionKey={nativeChatReasoningDisclosureKey(reasoning.message.id)}
            markdown={reasoning.markdown}
            fontScale={fontScale}
            onOpenFile={onOpenFile}
            onLongPress={INLINE_TEXT_SELECTION ? undefined : () => openActions(reasoning.message)}
          />
        </View>
      ) : null}
    </View>
  )
}

// Match the finished reasoning row’s geometry so its takeover cannot shift the text.
const styles = themedStyleSheet(() => ({
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
}))
