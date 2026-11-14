import { createElement, useContext } from 'react'
import type { TextProps } from 'react-native'
import { MarkdownTextContext } from './mobile-markdown-text-setup'

export function MarkdownText(props: TextProps): React.JSX.Element {
  const { TextComponent, androidTranscript, onLongPress } = useContext(MarkdownTextContext)
  if (!androidTranscript) {
    return createElement(TextComponent, props)
  }
  // Override selection without changing the nested spans' inherited behavior.
  return createElement(TextComponent, {
    ...props,
    ...(props.selectable === true ? { selectable: false } : {}),
    ...(onLongPress && props.onPress ? { onLongPress } : {})
  })
}
