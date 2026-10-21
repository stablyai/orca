import { useCallback, useEffect, useRef, type RefObject } from 'react'
import type { TextInput } from 'react-native'
import { bindTerminalTextFieldSubmit } from './terminal-text-field-submit-binding'

/**
 * A ref for a terminal text field that also binds the platform's submit signal to it.
 *
 * A callback ref rather than an effect over `fieldRef.current`: the field mounts and unmounts with
 * the mode it belongs to, and no prop or dependency marks that, so an effect would keep a listener
 * on a detached node. React reports both edges here.
 *
 * The listener is attached once per node and reads the handler through a ref, so a caller passing a
 * new closure each render does not cost a rebind. Callers must not freeze that closure; the rule
 * and its reason live in `terminal-field-submit-binding-wiring.test.ts`.
 *
 * No dependency list on the ref's effect, rather than one holding `onSubmit`: both of the dock's
 * field submits are rebuilt every render, because the `handleSend` they read is, so the dependency
 * would be a new value every time and there is nothing to compare. The ref mirrors the newest
 * closure after each commit, which is what it is for.
 */
export function useTerminalTextFieldSubmitBinding(
  fieldRef: RefObject<TextInput | null>,
  onSubmit: () => void
): (node: TextInput | null) => void {
  const onSubmitRef = useRef(onSubmit)
  useEffect(() => {
    onSubmitRef.current = onSubmit
  })
  const unbindRef = useRef<(() => void) | null>(null)

  return useCallback(
    (node: TextInput | null): void => {
      fieldRef.current = node
      unbindRef.current?.()
      unbindRef.current = node
        ? bindTerminalTextFieldSubmit(node, () => onSubmitRef.current())
        : null
    },
    [fieldRef]
  )
}
