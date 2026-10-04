// @vitest-environment happy-dom
import { createRequire } from 'node:module'
import { act, createElement, createRef, type ComponentType, type RefObject } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import type { TextInput } from 'react-native'
import { writeTerminalLiveInputText } from './terminal-live-input-text-write'
import { writeTerminalLiveInputText as writeTerminalLiveInputTextOnWeb } from './terminal-live-input-text-write.web'

/** A ref holding whatever the platform hands back, which on RN Web is the DOM node. */
const refTo = (node: unknown): RefObject<TextInput | null> => ({
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the point of these cases is that a DOM node is what the native signature receives on RN Web, which is the mismatch this sibling exists for.
  current: node as TextInput | null
})

function mountInput(): HTMLInputElement {
  const input = document.createElement('input')
  document.body.append(input)
  return input
}

describe('the native live-input write against an RN Web ref', () => {
  it('throws, because a DOM node has no setNativeProps', () => {
    expect(() => writeTerminalLiveInputText(refTo(mountInput()), 'typed')).toThrow(
      /setNativeProps is not a function/
    )
  })

  // Why this one matters: it is the case the session route is in before a terminal attaches, and
  // it is why the browser render check on that route stayed green on the defect above.
  it('writes nothing at all when the field has not mounted', () => {
    expect(() => writeTerminalLiveInputText(refTo(null), '')).not.toThrow()
  })
})

describe('the web sibling', () => {
  it('puts the text on the node the field is', () => {
    const input = mountInput()
    input.value = 'ime-preedit'

    writeTerminalLiveInputTextOnWeb(refTo(input), '')

    expect(input.value).toBe('')
  })

  it('writes a multiline field too, which RN Web renders as a textarea', () => {
    const area = document.createElement('textarea')
    document.body.append(area)

    writeTerminalLiveInputTextOnWeb(refTo(area), 'edited')

    expect(area.value).toBe('edited')
  })

  it('tolerates a field that has unmounted between the edit and the write', () => {
    expect(() => writeTerminalLiveInputTextOnWeb(refTo(null), '')).not.toThrow()
  })

  // A node with no `value` is left alone rather than grown one: an RN Web release that wraps the
  // field would otherwise get a stray property and the same silent no-paint the native call had.
  it('leaves a node that is not a field alone', () => {
    const div = document.createElement('div')

    writeTerminalLiveInputTextOnWeb(refTo(div), 'edited')

    expect(Object.hasOwn(div, 'value')).toBe(false)
  })
})

/**
 * The same write against the component it is written for, rather than against a node this file
 * built to match it.
 *
 * Every case above hands the writer an `<input>` of its own making, so an RN Web release that
 * rendered the field as something else would keep them all green and clear nothing on screen.
 * This one asks RN Web for the ref it puts in a `TextInput` and writes to that.
 */
describe('against a real react-native-web TextInput', () => {
  /**
   * Loaded through `createRequire` rather than imported: react-native-web ships no type
   * declarations, so a bare import is an implicit `any` and drops this file out of the
   * tests-typecheck ratchet.
   */
  const {
    TextInput: ReactNativeWebTextInput
  }: { TextInput: ComponentType<{ defaultValue: string; ref: RefObject<unknown> }> } =
    createRequire(import.meta.url)('react-native-web')

  it('clears the field react-native-web mounted, with no render behind it', async () => {
    // React 19 refuses `act` outside a test environment it has been told about.
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

      // Read off the document rather than off the ref, so this says the field on screen changed.
      const field = container.querySelector('input')
      expect(field).toBeInstanceOf(HTMLInputElement)
      expect(field?.value).toBe('')
    } finally {
      root.unmount()
      container.remove()
    }
  })
})
