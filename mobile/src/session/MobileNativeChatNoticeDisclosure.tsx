import { Pressable, StyleSheet, Text, View } from 'react-native'
import { ChevronRight, RotateCcw } from 'lucide-react-native'
import {
  nativeChatNoticeDisclosureKey,
  nativeChatNoticeDisclosureText,
  type NativeChatNoticeDisclosureLook
} from '../../../src/shared/native-chat-notice'
import type { NativeChatTextBlock } from '../../../src/shared/native-chat-types'
import { INLINE_TEXT_SELECTION } from '../components/inline-text-selection'
import { colors, spacing, radii } from '../theme/mobile-theme'
import { TEXT_SIZE, scaledType } from './mobile-native-chat-message-styles'
import { useMobileNativeChatDisclosure } from './mobile-native-chat-disclosure-store'

export function MobileNativeChatNoticeDisclosure({
  block,
  look,
  messageId,
  fontScale
}: {
  block: NativeChatTextBlock
  look: NativeChatNoticeDisclosureLook
  messageId?: string
  fontScale: number
}): React.JSX.Element {
  const [expanded, setExpanded] = useMobileNativeChatDisclosure(
    messageId === undefined ? undefined : nativeChatNoticeDisclosureKey(messageId),
    false
  )
  const detail = block.failure?.detail
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
        hitSlop={6}
        style={({ pressed }) => [styles.toggle, pressed && styles.pressed]}
      >
        {look.label === 'retrying' ? (
          <RotateCcw size={16 * fontScale} color={colors.textMuted} strokeWidth={2} />
        ) : null}
        <Text style={[styles.headline, scaledType(TEXT_SIZE, fontScale)]}>
          {nativeChatNoticeDisclosureText(look)}
        </Text>
        <View style={expanded ? styles.caretOpen : undefined}>
          <ChevronRight size={14 * fontScale} color={colors.textMuted} strokeWidth={2} />
        </View>
      </Pressable>
      {expanded ? (
        <View style={styles.body}>
          <Text
            selectable={INLINE_TEXT_SELECTION}
            style={[styles.text, scaledType(TEXT_SIZE, fontScale)]}
          >
            {block.text}
          </Text>
          {detail?.audience === 'person' && !block.text.includes(detail.text.trim()) ? (
            <Text
              selectable={INLINE_TEXT_SELECTION}
              style={[styles.text, scaledType(TEXT_SIZE, fontScale)]}
            >
              {detail.text}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  toggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 32,
    borderRadius: radii.row
  },
  pressed: { opacity: 0.6 },
  headline: { color: colors.textMuted, flex: 1 },
  caretOpen: { transform: [{ rotate: '90deg' }] },
  body: {
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: colors.borderSubtle,
    paddingLeft: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.sm
  },
  text: { color: colors.textPrimary }
})
