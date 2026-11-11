// @vitest-environment happy-dom
import { createRequire } from 'node:module'
import { act, createElement, createRef, type ComponentType, type RefObject } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import type { TextInput } from 'react-native'
import { writeTerminalLiveInputText as writeTerminalLiveInputTextOnWeb } from './terminal-live-input-text-write.web'

const refTo = (node: unknown): RefObject<TextInput | null> => ({
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the point of these cases is that a DOM node is what the native signature receives on RN Web, which is the mismatch this sibling exists for.
  current: node as TextInput | null
})

describe('the web sibling', () => {
  it('writes a multiline field too, which RN Web renders as a textarea', () => {
    const area = document.createElement('textarea')
    document.body.append(area)

    writeTerminalLiveInputTextOnWeb(refTo(area), 'edited')

    expect(area.value).toBe('edited')
  })
})

// Check the actual RN Web TextInput ref too; a hand-built input would miss component shape changes.
describe('against a real react-native-web TextInput', () => {
  // Require RN Web because it ships no type declarations; a bare import would lose tests-typecheck coverage.
  const {
    TextInput: ReactNativeWebTextInput
  }: { TextInput: ComponentType<{ defaultValue: string; ref: RefObject<unknown> }> } =
    createRequire(import.meta.url)('react-native-web')

  it('clears the field react-native-web mounted, with no render behind it', async () => {
    Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const fieldRef: RefObject<unknown> = createRef<unknown>()
    try {
      await act(async () => {
        root.render(
          createElement(ReactNativeWebTextInput, { defaultValue: 'ime-preedit', ref: fieldRef })
        )
      })

      writeTerminalLiveInputTextOnWeb(refTo(fieldRef.current), '')

      const field = container.querySelector('input')
      expect(field).toBeInstanceOf(HTMLInputElement)
      expect(field?.value).toBe('')
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })
})
