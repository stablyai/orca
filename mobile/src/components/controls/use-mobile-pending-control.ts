import { useRef, useState } from 'react'
import { triggerSelection } from '../../platform/haptics/haptics'

/**
 * MobilePendingButton's rule for a group of controls that each send and wait: one send at a time,
 * which control started it (that one shows `pending`), and the tick as it starts. `holdAccepted`
 * keeps an accepted send pending, for a card the host retires by remounting it.
 */
export function useMobilePendingControl<Control extends string>(
  options: { holdAccepted?: boolean } = {}
): {
  pending: Control | null
  /** The send's verdict, or false when another send is already out. */
  run: (control: Control, send: () => Promise<boolean>) => Promise<boolean>
} {
  const [pending, setPending] = useState<Control | null>(null)
  // Closes same-frame double taps before React disables the controls.
  const pendingRef = useRef<Control | null>(null)
  const run = async (control: Control, send: () => Promise<boolean>): Promise<boolean> => {
    if (pendingRef.current !== null) {
      return false
    }
    pendingRef.current = control
    setPending(control)
    triggerSelection()
    let accepted = false
    try {
      accepted = await send()
      return accepted
    } finally {
      if (!(accepted && options.holdAccepted)) {
        pendingRef.current = null
        setPending(null)
      }
    }
  }
  return { pending, run }
}
