import { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { composerInputStyles } from '../../../components/composer-input/composer-input-styles'
import {
  mobileNativeChatComposerSkillStyles as skillStyles,
  type MobileNativeChatComposerFieldProps
} from './mobile-native-chat-composer-field-skill'

function withoutHeightCap<T extends { maxHeight?: unknown }>({ maxHeight: _cap, ...style }: T) {
  return style
}

function TokenText({ text, skillToken }: { text: string; skillToken: string | null }) {
  if (!skillToken || !text.startsWith(skillToken)) {
    return text
  }
  return (
    <>
      <Text style={skillStyles.token}>{skillToken}</Text>
      {text.slice(skillToken.length)}
    </>
  )
}

// A styled copy drawn over the field while the field's own text is hidden.
// Dictation never writes the field: that would end the keyboard's own dictation or IME input.
export function MobileNativeChatComposerFieldCopy({
  value,
  skillToken,
  dictationPreview,
  fieldHeight,
  scrollTop
}: Pick<MobileNativeChatComposerFieldProps, 'value' | 'skillToken' | 'dictationPreview'> & {
  fieldHeight: number
  scrollTop: number
}) {
  const [heardEnd, setHeardEnd] = useState(0)
  // The copy grows past the field's height cap so it can be shifted; the frame clips it.
  const copyStyle = withoutHeightCap(StyleSheet.flatten(composerInputStyles.messageText))
  // While dictating, the line holding the newest word sits at the field's bottom, whatever the draft holds after it.
  const shift = dictationPreview ? Math.min(0, fieldHeight - heardEnd) : -scrollTop
  return (
    <View pointerEvents="none" aria-hidden style={StyleSheet.absoluteFill}>
      <Text style={[copyStyle, { transform: [{ translateY: shift }] }]}>
        {dictationPreview ? (
          <>
            <TokenText text={dictationPreview.before} skillToken={skillToken} />
            <Text style={skillStyles.dictationPreview}>{dictationPreview.text}</Text>
            {dictationPreview.after}
          </>
        ) : (
          <TokenText text={value} skillToken={skillToken} />
        )}
      </Text>
      {dictationPreview ? (
        <Text
          style={[copyStyle, styles.measure]}
          onLayout={(event) => setHeardEnd(event.nativeEvent.layout.height)}
        >
          {dictationPreview.before}
          {dictationPreview.text}
        </Text>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  measure: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    opacity: 0
  }
})
