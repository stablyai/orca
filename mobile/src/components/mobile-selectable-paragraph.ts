import type { ComponentType, ReactNode } from 'react'
import type { StyleProp, TextStyle } from 'react-native'

/** Paragraph layout for a run of merged selectable text, in points. */
export type MobileSelectableParagraphStyle = {
  firstLineHeadIndent?: number
  headIndent?: number
  spacing?: number
}

export type MobileSelectableParagraphComponent = ComponentType<{
  paragraph: MobileSelectableParagraphStyle
  style?: StyleProp<TextStyle>
  children: ReactNode
}>
