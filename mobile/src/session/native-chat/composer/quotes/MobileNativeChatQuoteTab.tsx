import type { RefObject } from 'react'
import { Pressable, Text, View, type TextInputInstance } from 'react-native'
import { Quote } from 'lucide-react-native'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { colors, spacing, typography } from '../../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../../theme/use-mobile-color-scheme'
import { queuedMessageStyles } from '../../input/queued-messages/mobile-native-chat-queued-message-styles'
import { useMobileNativeChatSelectionQuote } from './use-mobile-native-chat-selection-quote'
import {
  appendNativeChatQuote,
  formatNativeChatQuote
} from '../../../../../../src/shared/native-chat/input/quotes/native-chat-quote-selection'

// A mouse press would clear the selection, and with it the tab, before the click lands; desktop's offer does the same.
const KEEP_SELECTION_PROPS = {
  onMouseDown: (event: { preventDefault: () => void }) => event.preventDefault()
}

/** Offers the agent-reply passage the user selected as a quote, on the composer's top edge like the goal strip. */
export function MobileNativeChatQuoteTab({
  value,
  onChangeText,
  fieldRef
}: {
  /** The composer's draft, which the quote goes after as desktop's Add to chat puts it. */
  value: string
  onChangeText: (text: string) => void
  fieldRef: RefObject<TextInputInstance | null>
}): React.JSX.Element | null {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const quote = useMobileNativeChatSelectionQuote()
  if (quote === null) {
    return null
  }
  const label = t('chat.selectionQuote.action', 'Quote')
  return (
    <View
      style={[queuedMessageStyles.box, queuedMessageStyles.composerTab]}
      testID="selection-quote-tab"
      {...KEEP_SELECTION_PROPS}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint={t(
          'chat.selectionQuote.hint',
          'Adds the selected text to your message as a quote'
        )}
        style={({ pressed }) => [styles.line, pressed && styles.pressed]}
        onPress={() => {
          onChangeText(appendNativeChatQuote(value, formatNativeChatQuote(quote)))
          // In the tap itself: iOS opens the keyboard only for a focus the gesture made.
          fieldRef.current?.focus()
        }}
      >
        <Quote size={14} color={colors.textMuted} strokeWidth={2} />
        <Text style={styles.text} numberOfLines={1} ellipsizeMode="tail">
          {quote.replace(/\s+/g, ' ')}
        </Text>
        <View style={queuedMessageStyles.steerPill}>
          <Text style={queuedMessageStyles.steerLabel}>{label}</Text>
        </View>
      </Pressable>
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  line: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingLeft: spacing.md,
    paddingRight: spacing.xs
  },
  text: {
    flex: 1,
    minWidth: 0,
    color: colors.textMuted,
    fontSize: typography.metaSize
  },
  pressed: {
    backgroundColor: colors.bgRaised
  }
}))
