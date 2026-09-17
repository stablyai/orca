import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AskPrompt } from '../../../src/shared/native-chat-ask'
import { MobileCodexAskAccessoryKeys } from './MobileCodexAskAccessoryKeys'

vi.mock('react-native', () => ({ Pressable: 'Pressable', Text: 'Text' }))

vi.mock('./mobile-session-styles', () => ({
  styles: {
    accessoryKey: 'accessoryKey',
    accessoryKeyActive: 'accessoryKeyActive',
    accessoryKeyPressed: 'accessoryKeyPressed',
    accessoryKeyDisabled: 'accessoryKeyDisabled',
    accessoryKeyText: 'accessoryKeyText',
    accessoryKeyTextActive: 'accessoryKeyTextActive',
    accessoryKeyTextDisabled: 'accessoryKeyTextDisabled'
  }
}))

const prompt: AskPrompt = {
  questions: [{ question: 'q', options: [{ label: 'A' }] }]
}

describe('MobileCodexAskAccessoryKeys', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('Answer invokes the answer callback', async () => {
    const onAnswer = vi.fn()
    await act(async () => {
      renderer = create(
        createElement(MobileCodexAskAccessoryKeys, {
          ask: prompt,
          askKey: 'k1',
          onAnswer,
          onSkip: vi.fn(async () => true)
        })
      )
    })

    await act(async () =>
      renderer.root
        .findByProps({ accessibilityLabel: 'Answer the pending question' })
        .props.onPress()
    )

    expect(onAnswer).toHaveBeenCalledOnce()
  })

  it('Skip fires once, stays latched while in flight, and rearms on a new ask key', async () => {
    const onSkip = vi.fn(async () => true)
    await act(async () => {
      renderer = create(
        createElement(MobileCodexAskAccessoryKeys, {
          ask: prompt,
          askKey: 'k1',
          onAnswer: vi.fn(),
          onSkip
        })
      )
    })

    const skip = () =>
      renderer.root.findByProps({ accessibilityLabel: 'Skip the pending question' })
    await act(async () => skip().props.onPress())
    await act(async () => skip().props.onPress())

    expect(onSkip).toHaveBeenCalledOnce()
    expect(skip().props.disabled).toBe(true)

    await act(async () =>
      renderer.update(
        createElement(MobileCodexAskAccessoryKeys, {
          ask: prompt,
          askKey: 'k2',
          onAnswer: vi.fn(),
          onSkip
        })
      )
    )
    expect(skip().props.disabled).toBe(false)
  })

  it('re-enables Skip when the write is rejected', async () => {
    const onSkip = vi.fn(async () => false)
    await act(async () => {
      renderer = create(
        createElement(MobileCodexAskAccessoryKeys, {
          ask: prompt,
          askKey: 'k1',
          onAnswer: vi.fn(),
          onSkip
        })
      )
    })

    const skip = () =>
      renderer.root.findByProps({ accessibilityLabel: 'Skip the pending question' })
    await act(async () => skip().props.onPress())

    expect(skip().props.disabled).toBe(false)
  })
})
