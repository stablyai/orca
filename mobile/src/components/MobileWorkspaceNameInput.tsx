import { type TextInputInstance, TextInput, type TextInputProps } from 'react-native'
import { useEffect, useRef } from 'react'

const MOBILE_WORKSPACE_NAME_FOCUS_DELAY_MS = 220

type MobileWorkspaceNameInputProps = TextInputProps & {
  shouldAutoFocus: boolean
  focusKey?: unknown
}

export function MobileWorkspaceNameInput({
  shouldAutoFocus,
  focusKey,
  ...props
}: MobileWorkspaceNameInputProps) {
  const inputRef = useRef<TextInputInstance>(null)

  useEffect(() => {
    if (!shouldAutoFocus) {
      return
    }

    // Why: bottom drawers animate in before the field is visually settled;
    // focusing after the animation makes mobile soft keyboards appear reliably.
    const timeout = setTimeout(() => {
      inputRef.current?.focus()
    }, MOBILE_WORKSPACE_NAME_FOCUS_DELAY_MS)

    return () => clearTimeout(timeout)
  }, [focusKey, shouldAutoFocus])

  return (
    <TextInput
      ref={inputRef}
      placeholder="Workspace name"
      autoCapitalize="none"
      autoCorrect={false}
      showSoftInputOnFocus
      {...props}
    />
  )
}
