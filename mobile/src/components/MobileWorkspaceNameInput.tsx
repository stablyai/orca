import { useEffect, useRef } from 'react'
import { TextInput, type TextInputProps } from 'react-native'

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
  const inputRef = useRef<TextInput>(null)

  useEffect(() => {
    if (!shouldAutoFocus) {
      return
    }

    // Focus after drawer animation settles so soft keyboard appears reliably.
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
