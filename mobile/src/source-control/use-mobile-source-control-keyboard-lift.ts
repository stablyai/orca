import { useMobileKeyboardInset } from '../hooks/use-mobile-keyboard-inset'

export function useMobileSourceControlKeyboardLift(): number {
  return useMobileKeyboardInset().height
}
