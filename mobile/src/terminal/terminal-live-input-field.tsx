import { forwardRef, useImperativeHandle, useRef } from 'react'
import {
  findNodeHandle,
  Platform,
  TextInput,
  UIManager,
  requireNativeComponent,
  type TextInputProps
} from 'react-native'
import type { TerminalLiveInputChangeEvent } from './use-terminal-live-input-commit'

type TerminalLiveInputFieldProps = Omit<TextInputProps, 'onChange'> & {
  readonly onChange: (event: TerminalLiveInputChangeEvent) => void
}

type AndroidTerminalInputProps = Omit<TerminalLiveInputFieldProps, 'onChange'> & {
  readonly onTerminalInput: TerminalLiveInputFieldProps['onChange']
}

const AndroidTerminalInput =
  Platform.OS === 'android'
    ? requireNativeComponent<AndroidTerminalInputProps>('OrcaTerminalInput')
    : null

export type TerminalLiveInputFieldHandle = Pick<TextInput, 'blur' | 'focus' | 'setNativeProps'>

function runInputCommand(input: TextInput | null, command: 'blur' | 'focus'): void {
  if (!AndroidTerminalInput) {
    input?.[command]()
    return
  }
  const tag = findNodeHandle(input)
  if (tag !== null) {
    UIManager.dispatchViewManagerCommand(tag, command, [])
  }
}

export const TerminalLiveInputField = forwardRef<
  TerminalLiveInputFieldHandle,
  TerminalLiveInputFieldProps
>(function TerminalLiveInputField({ onChange, ...props }, ref) {
  const inputRef = useRef<TextInput>(null)
  useImperativeHandle(ref, () => ({
    blur: () => runInputCommand(inputRef.current, 'blur'),
    focus: () => runInputCommand(inputRef.current, 'focus'),
    setNativeProps: (nativeProps) => inputRef.current?.setNativeProps(nativeProps)
  }))

  if (AndroidTerminalInput) {
    return <AndroidTerminalInput {...props} ref={inputRef as never} onTerminalInput={onChange} />
  }
  return <TextInput {...props} ref={inputRef} onChange={onChange as TextInputProps['onChange']} />
})
