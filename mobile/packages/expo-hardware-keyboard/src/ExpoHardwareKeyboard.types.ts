import type { ReactNode } from 'react'
import type { StyleProp, ViewStyle } from 'react-native'

export type HardwareKeyboardModifiers = {
  readonly ctrl: boolean
  readonly alt: boolean
  readonly shift: boolean
  readonly meta: boolean
}

export type HardwareKeyboardKeyEvent = {
  readonly key: string
  readonly modifiers: HardwareKeyboardModifiers
  readonly repeat: boolean
  readonly fieldBoundary?: {
    readonly text: string
    readonly eventCount: number
    readonly target: number
  }
}

export type HardwareKeyboardCaptureViewProps = {
  readonly hardwarePaste?: boolean
  readonly submitWithPrimaryModifier?: boolean
  readonly nativeFieldBoundaries?: boolean
  readonly mode?: 'terminal' | 'submit'
  readonly enabled?: boolean
  readonly onHardwareKey?: (event: { nativeEvent: HardwareKeyboardKeyEvent }) => void
  readonly children?: ReactNode
  readonly style?: StyleProp<ViewStyle>
}
