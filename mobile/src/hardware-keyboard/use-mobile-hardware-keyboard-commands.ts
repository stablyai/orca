import { useCallback, useLayoutEffect, useRef } from 'react'
import { useFocusEffect } from 'expo-router'
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
  useLayoutEffect(() => {
    handlerRef.current = options.onCommand
  }, [options.onCommand])

  useFocusEffect(
    useCallback(
      () =>
        registerMobileHardwareKeyboardScope({
          actionIds: options.actionIds,
          context: options.context,
          handler: (event) => handlerRef.current(event)
        }),
      [options.actionIds, options.context]
    )
  )
}
