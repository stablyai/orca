import { useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import type { SayAutomationRun } from '../../../../../src/shared/automations/automation-run-row-words'
import { typography } from '../../../theme/mobile-theme'
import { stylesSheet as markdownStylesSheet } from '../../../components/markdown/mobile-markdown-styles'
import { MobileNativeChatMarkdown } from './message-content/MobileNativeChatMarkdown'
import { useMobileNativeChatDisclosure } from './viewport/mobile-native-chat-disclosure-store'
import { scaledType } from './messages/mobile-native-chat-message-styles'
import { stylesSheet } from './mobile-automation-run-row-styles'
import { useThemedStyles } from '../../../theme/themed-styles'

const FOLDED_LINES = 4

/** The automation's saved prompt: four lines, then Show all, as on desktop. */
export function MobileAutomationRunInstructions({
  messageId,
  instructions,
  fontScale,
  say
}: {
  messageId: string
  instructions: string
  fontScale: number
  say: SayAutomationRun
}): React.JSX.Element {
  const styles = useThemedStyles(stylesSheet)
  const markdownStyles = useThemedStyles(markdownStylesSheet)
  const [whole, setWhole] = useMobileNativeChatDisclosure(
    `automation-run-instructions:${messageId}`,
    false
  )
  // The unclamped text's height, measured off-screen: onTextLayout differs per platform and is absent on web.
  const [overflows, setOverflows] = useState(false)
  // The details' size: part of the row, not a chat reply.
  const prose = scaledType(typography.metaSize, fontScale)
  return (
    <View>
      {whole ? (
        <MobileNativeChatMarkdown
          content={instructions}
          rangeSelectable
          textScale={prose.fontSize / markdownStyles.paragraph.fontSize}
        />
      ) : (
        <View>
          <Text numberOfLines={FOLDED_LINES} style={[styles.quoteText, prose]}>
            {instructions}
          </Text>
          <Text
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={[styles.quoteText, prose, styles.measure]}
            onLayout={(event) =>
              setOverflows(event.nativeEvent.layout.height > FOLDED_LINES * prose.lineHeight + 1)
            }
          >
            {instructions}
          </Text>
        </View>
      )}
      {overflows || whole ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: whole }}
          onPress={() => setWhole(!whole)}
          style={styles.showAll}
        >
          <Text style={[styles.link, scaledType(typography.metaSize, fontScale, 4)]}>
            {whole ? say('showLess') : say('showAll')}
          </Text>
        </Pressable>
      ) : null}
    </View>
  )
}
