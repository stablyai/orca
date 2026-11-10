import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { MobileNativeChatComposerField } from './MobileNativeChatComposerField'
import {
  findAllByHostType,
  findByHostType
} from '../../../test-support/react-test-renderer-host-nodes'

vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles, flatten: (style: unknown) => style },
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View'
}))

describe('MobileNativeChatComposerField', () => {
  it('stays the same field, controlled by the draft, while heard words show over it', () => {
    const draw = (dictationPreview: { before: string; text: string; after: string } | null) =>
      createElement(MobileNativeChatComposerField, {
        value: '/review Ok',
        skillToken: '/review',
        dictationPreview
      })
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(draw(null))
    })
    const field = findByHostType(renderer.root, 'TextInput')
    act(() => renderer.update(draw({ before: '/review Ok ', text: 'there', after: '' })))
    // Rich-text children would let the native field drive its own text and drift from the draft.
    expect(findByHostType(renderer.root, 'TextInput')).toBe(field)
    expect(field.props.value).toBe('/review Ok')
    expect(field.props.children).toBeUndefined()
    const shown = findAllByHostType(renderer.root, 'Text').map((node) => node.props.children)
    expect(shown).toContain('there')
  })
})
