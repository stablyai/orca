import { createElement, createContext, useContext, type ComponentType } from 'react'
import { Text as NativeText, type TextProps } from 'react-native'

type MarkdownTextSetup = {
  TextComponent: ComponentType<TextProps>
  /** Disable native selection only within the Android transcript. */
  androidTranscript: boolean
  onLongPress?: () => void
}
const MarkdownTextContext = createContext<MarkdownTextSetup>({
  TextComponent: NativeText,
  androidTranscript: false
})
export { MarkdownTextContext }
export type { MarkdownTextSetup }

function MarkdownText(props: TextProps): React.JSX.Element {
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
export { MarkdownText }
