import { Platform, StyleSheet, Text, type TextStyle } from 'react-native'
import type { MobileSyntaxSegment, MobileSyntaxTokenKind } from '../session/mobile-file-syntax'
import { colors } from '../theme/mobile-theme'

export function MobileSyntaxSegments({ segments }: { segments: MobileSyntaxSegment[] }) {
  let sourceOffset = 0
  return (
    <>
      {segments.map((segment) => {
        const key = `${sourceOffset}:${segment.kind}`
        sourceOffset += segment.text.length
        return (
          <Text key={key} style={[webSyntaxTextStyle, syntaxTokenStyles[segment.kind]]}>
            {segment.text}
          </Text>
        )
      })}
    </>
  )
}

// Why: nested native Text resolves to the system face while RNW otherwise inherits the mono parent.
const webSyntaxTextStyle = Platform.OS === 'web' ? { fontFamily: 'System' } : undefined

const syntaxTokenStyles: Record<MobileSyntaxTokenKind, TextStyle> = StyleSheet.create({
  plain: {
    color: colors.textPrimary
  },
  comment: {
    color: colors.syntaxComment
  },
  keyword: {
    color: colors.syntaxKeyword
  },
  string: {
    color: colors.syntaxString
  },
  number: {
    color: colors.syntaxNumber
  },
  type: {
    color: colors.syntaxType
  },
  function: {
    color: colors.syntaxFunction
  },
  variable: {
    color: colors.syntaxVariable
  },
  meta: {
    color: colors.syntaxMeta
  }
})
