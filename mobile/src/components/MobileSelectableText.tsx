import type { MobileSelectableParagraphComponent } from './mobile-selectable-paragraph'

export { Text as MobileSelectableText } from 'react-native'

// Paragraph merging needs the iOS selectable text view.
export const MobileSelectableParagraph: MobileSelectableParagraphComponent | null = null
