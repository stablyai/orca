import { StyleSheet, Text, type TextStyle } from 'react-native'
import type { MobileSyntaxSegment, MobileSyntaxTokenKind } from '../session/mobile-file-syntax'
import type { ThemeColors } from '../theme/mobile-theme'
import { useThemedStyles } from '../theme/theme-context'

export function MobileSyntaxSegments({ segments }: { segments: MobileSyntaxSegment[] }) {
  const syntaxTokenStyles = useThemedStyles(createSyntaxTokenStyles)
  return (
    <>
      {segments.map((segment, index) => (
        <Text key={`${index}:${segment.kind}`} style={syntaxTokenStyles[segment.kind]}>
          {segment.text}
        </Text>
      ))}
    </>
  )
}

const createSyntaxTokenStyles = (colors: ThemeColors): Record<MobileSyntaxTokenKind, TextStyle> =>
  StyleSheet.create({
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
