import { Text, type TextStyle } from 'react-native'
import type { MobileSyntaxSegment, MobileSyntaxTokenKind } from '../session/mobile-file-syntax'
import { colors } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'

export function MobileSyntaxSegments({ segments }: { segments: MobileSyntaxSegment[] }) {
  useMobileColorScheme()
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

const syntaxTokenStyles: Record<MobileSyntaxTokenKind, TextStyle> = themedStyleSheet(() => ({
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
}))
