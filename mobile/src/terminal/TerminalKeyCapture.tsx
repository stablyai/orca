import type { ReactNode } from 'react'
import type { StyleProp, ViewStyle } from 'react-native'
import type { TerminalKeyChord } from '../../modules/orca-terminal-key-capture/src'

export type TerminalKeyCaptureProps = {
  readonly children: ReactNode
  readonly style: StyleProp<ViewStyle>
  readonly onKey: (chord: TerminalKeyChord) => void
}

// Why: only Android delivers IME and hardware-keyboard chords as key events the field drops.
export function TerminalKeyCapture({ children }: TerminalKeyCaptureProps): React.JSX.Element {
  return <>{children}</>
}
