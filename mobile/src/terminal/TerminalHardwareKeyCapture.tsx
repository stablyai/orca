import type { ReactNode } from 'react'
import type { StyleProp, ViewStyle } from 'react-native'
import type { TerminalLiveInputHardwareKeyEvent } from './use-terminal-live-input-commit'

export type TerminalHardwareKeyCaptureProps = {
  readonly style: StyleProp<ViewStyle>
  readonly onTerminalKey: (event: TerminalLiveInputHardwareKeyEvent) => void
  readonly children: ReactNode
}

/** Android only (see the `.android` sibling); elsewhere the field's own key events are all there is. */
export function TerminalHardwareKeyCapture({ children }: TerminalHardwareKeyCaptureProps) {
  return children
}
