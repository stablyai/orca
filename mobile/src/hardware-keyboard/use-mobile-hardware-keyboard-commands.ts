import { useEffect, useRef } from 'react'
import type { HardwareKeyboardCommandEvent } from '@orca/expo-hardware-keyboard-navigation'
import type { KeybindingContext } from '../../../src/shared/keybindings'
import type { MobileHardwareKeyboardActionId } from './mobile-hardware-keyboard-actions'
import { registerMobileHardwareKeyboardScope } from './mobile-hardware-keyboard-registry'

export function useMobileHardwareKeyboardCommands(options: {
  actionIds: readonly MobileHardwareKeyboardActionId[]
  context: KeybindingContext
  onCommand: (event: HardwareKeyboardCommandEvent) => void
}): void {
  const handlerRef = useRef(options.onCommand)
  handlerRef.current = options.onCommand

  useEffect(
    () =>
      registerMobileHardwareKeyboardScope({
        actionIds: options.actionIds,
        context: options.context,
        handler: (event) => handlerRef.current(event)
      }),
    [options.actionIds, options.context]
  )
}
