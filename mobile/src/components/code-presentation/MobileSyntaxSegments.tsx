import { Text, type TextStyle } from 'react-native'
import type {
  MobileSyntaxSegment,
  MobileSyntaxTokenKind
} from '../../files/session-documents/mobile-file-syntax'
import { themedStyleSheet, useThemedStyles, type ThemedStyles } from '../../theme/themed-styles'

export function MobileSyntaxSegments({ segments }: { segments: MobileSyntaxSegment[] }) {
  const syntaxTokenStyles = useThemedStyles(syntaxTokenStylesSheet)
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

const syntaxTokenStylesSheet: ThemedStyles<Record<MobileSyntaxTokenKind, TextStyle>> =
  themedStyleSheet((colors) => ({
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
    },
    tag: {
      color: colors.syntaxTag
    }
  }))
