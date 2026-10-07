import { Children, Fragment, isValidElement, type ReactNode } from 'react'
import { StyleSheet, Text, UIManager, type TextProps } from 'react-native'
import { UITextView } from 'react-native-uitextview'

// Older development clients can load this bundle before rebuilding their native views.
const hasRangeSelection = UIManager.hasViewManagerConfig('RNUITextView')

function flattenFragments(children: ReactNode): ReactNode[] {
  return (
    Children.map(children, (child) =>
      isValidElement<{ children?: ReactNode }>(child) && child.type === Fragment
        ? flattenFragments(child.props.children)
        : child
    ) ?? []
  )
}

export function MobileSelectableText({ children, style, ...props }: TextProps): React.JSX.Element {
  if (!hasRangeSelection) {
    return (
      <Text {...props} style={style}>
        {children}
      </Text>
    )
  }

  // The native span adapter otherwise maps numeric bold to semibold.
  const textStyle = StyleSheet.flatten(style)
  const nativeStyle =
    textStyle?.fontWeight === '700' || textStyle?.fontWeight === 700
      ? { ...textStyle, fontWeight: 'bold' as const }
      : style
  return (
    <UITextView {...props} uiTextView style={nativeStyle}>
      {flattenFragments(children)}
    </UITextView>
  )
}
