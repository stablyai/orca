import { useContext } from 'react'
import { Pressable, View } from 'react-native'
import { TextQuote } from 'lucide-react-native'
import { MobileSourceCopyButton } from '../../../components/MobileSourceCopyButton'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { colors, radii } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { MobileNativeChatQuoteContext } from './mobile-native-chat-quote-context'

/** Copy, and Quote for agent replies, under a chat turn. */
export function MobileNativeChatMessageCopyActions({
  text,
  quotable
}: {
  text: string
  quotable: boolean
}): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const quote = useContext(MobileNativeChatQuoteContext)
  return (
    // The 24 pt boxes centre 14 pt glyphs; pulling 5 pt back lines the first glyph up with the tool icons.
    <View style={styles.row}>
      <MobileSourceCopyButton
        text={text}
        accessibilityLabel={t('chat.message.copyMessage', 'Copy message')}
      />
      {quote && quotable ? (
        <Pressable
          style={({ pressed }) => [styles.button, pressed && styles.pressed]}
          // A short left reach leaves the Copy button's own box to Copy.
          hitSlop={{ top: 10, bottom: 10, left: 4, right: 10 }}
          accessibilityRole="button"
          accessibilityLabel={t('chat.message.quoteMessage', 'Quote message')}
          onPress={() => quote(text)}
        >
          <TextQuote size={14} color={colors.textMuted} />
        </Pressable>
      ) : null}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  row: { flexDirection: 'row', gap: 6, marginHorizontal: -5 },
  // Sized like the Copy button beside it.
  button: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.control
  },
  pressed: { backgroundColor: colors.bgRaised }
}))
