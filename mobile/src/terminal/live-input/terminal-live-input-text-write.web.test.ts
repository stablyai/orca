// @vitest-environment happy-dom
import { createRequire } from 'node:module'
import { act, createElement, createRef, Fragment, type ComponentType, type RefObject } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import type { TextInputInstance } from 'react-native'
import { writeTerminalLiveInputText as writeTerminalLiveInputTextOnWeb } from './terminal-live-input-text-write.web'

const refTo = (node: unknown): RefObject<TextInputInstance | null> => ({
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the point of these cases is that a DOM node is what the native signature receives on RN Web, which is the mismatch this sibling exists for.
  current: node as TextInputInstance | null
})

// Require RN Web because it ships no type declarations.
const {
  TextInput: ReactNativeWebTextInput
}: {
  TextInput: ComponentType<{
    defaultValue: string
    multiline?: boolean
    ref: RefObject<unknown>
  }>
} = createRequire(import.meta.url)('react-native-web')

it('clears the input and textarea mounted by react-native-web without a rerender', async () => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const inputRef = createRef<unknown>()
  const textareaRef = createRef<unknown>()
  try {
    await act(async () => {
      root.render(
        createElement(
          Fragment,
          null,
          createElement(ReactNativeWebTextInput, { defaultValue: 'ime-preedit', ref: inputRef }),
          createElement(ReactNativeWebTextInput, {
            defaultValue: 'multiline-preedit',
            multiline: true,
            ref: textareaRef
          })
        )
      )
    })

    const input = container.querySelector('input')
    const textarea = container.querySelector('textarea')
    expect(input?.value).toBe('ime-preedit')
    expect(textarea?.value).toBe('multiline-preedit')

    writeTerminalLiveInputTextOnWeb(refTo(inputRef.current), '')
    writeTerminalLiveInputTextOnWeb(refTo(textareaRef.current), '')

    expect(input?.value).toBe('')
    expect(textarea?.value).toBe('')
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
})
