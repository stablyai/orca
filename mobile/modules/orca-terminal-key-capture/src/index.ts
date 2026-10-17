import { requireNativeViewManager, requireOptionalNativeModule } from 'expo-modules-core'
import type { ComponentType } from 'react'
import type { NativeSyntheticEvent, ViewProps } from 'react-native'

/**
 * A key-down the view took from its focused child, in the vocabulary `buildTerminalShortcutKey`
 * accepts. A printable `key` already has Shift applied, so `shift` is only set on special keys.
 */
export type TerminalKeyChord = {
  key: string
  ctrl: boolean
  alt: boolean
  shift: boolean
}

export type OrcaTerminalKeyCaptureViewProps = ViewProps & {
  onTerminalKey: (event: NativeSyntheticEvent<TerminalKeyChord>) => void
}

// Why: a development client built before this module existed can still load this bundle.
export const OrcaTerminalKeyCaptureView: ComponentType<OrcaTerminalKeyCaptureViewProps> | null =
  requireOptionalNativeModule('OrcaTerminalKeyCapture')
    ? requireNativeViewManager<OrcaTerminalKeyCaptureViewProps>('OrcaTerminalKeyCapture')
    : null
