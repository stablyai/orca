import { requireNativeViewManager } from 'expo-modules-core'
import type { ComponentType } from 'react'
import type { NativeSyntheticEvent, ViewProps } from 'react-native'

/** `key` is a DOM-style name (`Escape`, `ArrowUp`, `F5`) or the key's unmodified ASCII character. */
export type TerminalKeyChordPayload = {
  key: string
  ctrl: boolean
  alt: boolean
  shift: boolean
}

export type OrcaTerminalKeyCaptureViewProps = ViewProps & {
  /** A key-down the view took from the focused field inside it; the field never sees it. */
  onTerminalKey?: (event: NativeSyntheticEvent<TerminalKeyChordPayload>) => void
}

/** Android only: the module is not linked on iOS and this throws in a browser. */
export const OrcaTerminalKeyCaptureView: ComponentType<OrcaTerminalKeyCaptureViewProps> =
  requireNativeViewManager<OrcaTerminalKeyCaptureViewProps>('OrcaTerminalKeyCapture')
