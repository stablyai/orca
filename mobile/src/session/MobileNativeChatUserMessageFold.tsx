import { useMemo, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import {
  NATIVE_CHAT_USER_MESSAGE_MAX_UNFOLDED_LINES,
  nativeChatUserMessageFolds
} from '../../../src/shared/native-chat-user-message-fold'
import { styles as markdownStyles } from '../components/mobile-markdown-styles'
import { spacing } from '../theme/mobile-theme'
import { MobileNativeChatTextAction } from './MobileNativeChatTextAction'
import type { useMobileNativeChatFullMessage } from './MobileNativeChatFullContent'

const FOLDED_HEIGHT =
  NATIVE_CHAT_USER_MESSAGE_MAX_UNFOLDED_LINES * markdownStyles.paragraph.lineHeight

/** A long message of yours, folded to its first lines until opened. Desktop parity:
 *  `NativeChatUserMessageFold`, with the same text rule. */
export function MobileNativeChatUserMessageFold({
  text,
  fontScale,
  open,
  onToggle,
  recovery,
  status,
  children
}: {
  text: string
  fontScale: number
  /** The transcript's state, which outlives this row when the list recycles it. */
  open: boolean
  onToggle: () => void
  recovery?: ReturnType<typeof useMobileNativeChatFullMessage>['recovery']
  status?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  const longText = useMemo(() => nativeChatUserMessageFolds(text), [text])
  // The text rule can pick a message that already fits the fold; that one gets no toggle.
  const [height, setHeight] = useState<number | null>(null)
  const clip = FOLDED_HEIGHT * fontScale
  // Native text inside the clip is laid out to fit it, so a cut message measures at the clip, not
  // its full height: reaching it means cut (1pt for rounding). Unfolding on `>` looped.
  const folds = longText && (height === null || height >= clip - 1)
  return (
    <>
      {longText ? (
        <View style={folds && !open ? { maxHeight: clip, overflow: 'hidden' } : undefined}>
          <View onLayout={(event) => setHeight(event.nativeEvent.layout.height)}>{children}</View>
        </View>
      ) : (
        children
      )}
      {(!longText || height !== null) && (folds || recovery) ? (
        <MobileNativeChatTextAction
          align="end"
          style={styles.toggle}
          expanded={open}
          onPress={() => {
            onToggle()
            if (!open && recovery && recovery.load !== 'loading') {
              recovery.onPress()
            }
          }}
          label={
            open
              ? 'Show less'
              : recovery?.load === 'failed'
                ? "Show full message — couldn't load, tap to retry"
                : 'Show full message'
          }
        />
      ) : null}
      {!recovery || (open && recovery.load === 'failed') ? status : null}
    </>
  )
}

// The bubble's bottom padding is part of the toggle's 44 pt target.
const styles = StyleSheet.create({
  toggle: {
    marginBottom: -spacing.sm
  }
})
