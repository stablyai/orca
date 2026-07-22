import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AskPrompt } from './mobile-native-chat-ask'
import { useMobileNativeChatAskDismiss } from './use-mobile-native-chat-ask-dismiss'

describe('useMobileNativeChatAskDismiss', () => {
  let renderer: ReactTestRenderer | null = null
  let state: ReturnType<typeof useMobileNativeChatAskDismiss> | null = null

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    state = null
  })

  function Harness({ prompt }: { prompt: AskPrompt }): null {
    state = useMobileNativeChatAskDismiss(prompt)
    return null
  }

  const first: AskPrompt = {
    questions: [
      { question: 'same first', multiSelect: false, options: [] },
      { question: 'old second', multiSelect: false, options: [] }
    ]
  }
  const replacement: AskPrompt = {
    questions: [
      { question: 'same first', multiSelect: false, options: [] },
      { question: 'new second', multiSelect: false, options: [] }
    ]
  }

  it('shows a structurally different replacement without an intervening null', async () => {
    const original = console.error
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      if (typeof args[0] === 'string' && args[0].includes('react-test-renderer is deprecated')) {
        return
      }
      original(...args)
    })
    try {
      await act(async () => {
        renderer = create(createElement(Harness, { prompt: first }))
      })
    } finally {
      consoleSpy.mockRestore()
    }
    act(() => state?.dismissAsk())
    expect(state?.showAsk).toBe(false)

    await act(async () => renderer?.update(createElement(Harness, { prompt: replacement })))
    expect(state?.showAsk).toBe(true)
  })
})
