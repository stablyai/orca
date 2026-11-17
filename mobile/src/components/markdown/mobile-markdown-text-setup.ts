import { createContext, type ComponentType } from 'react'
import { Text as NativeText, type TextProps } from 'react-native'

export type MarkdownTextSetup = {
  TextComponent: ComponentType<TextProps>
  /** Disable native selection only within the Android transcript. */
  androidTranscript: boolean
  onLongPress?: () => void
}

export const MarkdownTextContext = createContext<MarkdownTextSetup>({
  TextComponent: NativeText,
  androidTranscript: false
})
