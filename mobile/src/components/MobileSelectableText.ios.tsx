import { Text, UIManager } from 'react-native'
import {
  SelectableText,
  SelectableTextParagraph,
  type SelectableTextProps
} from '@orca/selectable-text'
import type { MobileSelectableParagraphComponent } from './mobile-selectable-paragraph'

// Development clients built before the module fall back to plain Text.
const hasRangeSelection = UIManager.hasViewManagerConfig('OrcaSelectableText')

export function MobileSelectableText({
  children,
  style,
  ...props
}: SelectableTextProps): React.JSX.Element {
  if (!hasRangeSelection) {
    return (
      <Text {...props} style={style}>
        {children}
      </Text>
    )
  }
  return (
    <SelectableText {...props} style={style}>
      {children}
    </SelectableText>
  )
}

export const MobileSelectableParagraph: MobileSelectableParagraphComponent | null =
  hasRangeSelection ? SelectableTextParagraph : null
