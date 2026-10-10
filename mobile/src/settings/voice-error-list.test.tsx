import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VoiceErrorList } from './voice-error-list'

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  StyleSheet: { create: (value: unknown) => value }
}))

let renderer: ReactTestRenderer | undefined

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = undefined
})

function render(messages: readonly string[]): ReactTestRenderer {
  act(() => {
    renderer = create(createElement(VoiceErrorList, { messages }))
  })
  if (!renderer) {
    throw new Error('list did not render')
  }
  return renderer
}

describe('VoiceErrorList', () => {
  it('renders each error as its own text in a spaced column', () => {
    expect(render(['Disk full', 'Could not update']).toJSON()).toMatchObject({
      type: 'View',
      props: { style: { gap: 4 } },
      children: [
        { type: 'Text', children: ['Disk full'] },
        { type: 'Text', children: ['Could not update'] }
      ]
    })
  })

  it('renders nothing without errors', () => {
    expect(render([]).toJSON()).toBeNull()
  })
})
