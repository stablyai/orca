import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ListRow } from '../../components/list/ListGroup'
import { ChatGptAccountPicker } from './ChatGptAccountPicker'
import type { MobileSpeechSetup } from '../mobile-dictation-setup'

// The mock factory is hoisted before static imports initialize.
vi.mock(
  '../../components/list/ListGroup',
  async () => (await import('../../test-support/settings-chrome-test-double')).listGroupDouble
)
vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 },
  AppState: { addEventListener: () => ({ remove() {} }) }
}))

let renderer: ReactTestRenderer

afterEach(() => {
  act(() => renderer?.unmount())
})

describe('host dictation account picker', () => {
  it('does not inherit the first account or replace a removed selection, and changes only on a user choice', () => {
    const onChange = vi.fn()
    const setup: MobileSpeechSetup = {
      models: [],
      chatGptAccountId: null,
      chatGptAccounts: [
        { id: 'personal', label: 'Personal' },
        { id: 'work', label: 'Work' }
      ]
    }
    act(() => {
      renderer = create(createElement(ChatGptAccountPicker, { setup, disabled: false, onChange }))
    })
    expect(onChange).not.toHaveBeenCalled()
    const work = () =>
      renderer.root.findAllByType(ListRow).find((row) => row.props.title === 'Work')!
    expect(
      renderer.root.findAllByType(ListRow).find((row) => row.props.title === 'Personal')!.props
        .selected
    ).toBe(false)
    expect(work().props.selected).toBe(false)
    act(() => {
      work().props.onPress()
    })
    expect(onChange).toHaveBeenCalledWith('work')
    onChange.mockClear()
    act(() => {
      renderer.update(
        createElement(ChatGptAccountPicker, {
          setup: { ...setup, chatGptAccountId: 'removed' },
          disabled: false,
          onChange
        })
      )
    })
    expect(renderer.root.findAllByType(ListRow).every((row) => !row.props.selected)).toBe(true)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('offers no account writes when an older host omits support', () => {
    const onChange = vi.fn()
    act(() => {
      renderer = create(
        createElement(ChatGptAccountPicker, { setup: { models: [] }, disabled: false, onChange })
      )
    })
    expect(renderer.root.findAllByType(ListRow)).toHaveLength(0)
  })
})
