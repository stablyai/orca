import { useCallback, useEffect, useRef, type RefObject } from 'react'
import type { TextInput } from 'react-native'
import type { TerminalLiveAccessoryInput } from './terminal-live-accessory-input'
import { bindTerminalTextFieldSubmit } from './terminal-text-field-submit-binding'

// Bind through callback refs because mode changes mount/unmount fields without a dependency signal.
// Keep one listener per node and mirror fresh submit closures after every commit so guards cannot capture stale client/handle values.
export function useTerminalTextFieldSubmitBinding(
  fieldRef: RefObject<TextInput | null>,
  onSubmit: () => void,
  onKeyChord?: (input: TerminalLiveAccessoryInput) => boolean,
  onCompositionEnd?: (text: string) => void
): (node: TextInput | null) => void {
  const onSubmitRef = useRef(onSubmit)
  const onKeyChordRef = useRef(onKeyChord)
  const onCompositionEndRef = useRef(onCompositionEnd)
  useEffect(() => {
    onSubmitRef.current = onSubmit
    onKeyChordRef.current = onKeyChord
    onCompositionEndRef.current = onCompositionEnd
  })
  const unbindRef = useRef<(() => void) | null>(null)

  return useCallback(
    (node: TextInput | null): void => {
      fieldRef.current = node
      unbindRef.current?.()
      unbindRef.current = node
        ? bindTerminalTextFieldSubmit(
            node,
            () => onSubmitRef.current(),
            (input) => onKeyChordRef.current?.(input) ?? false,
            (text) => onCompositionEndRef.current?.(text)
          )
        : null
    },
    [fieldRef]
  )
}
