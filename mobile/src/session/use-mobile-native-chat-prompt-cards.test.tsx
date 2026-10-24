import { createElement, useState } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mobileNativeChatPromptDismissals } from './mobile-native-chat-prompt-dismissals'
import { useMobileNativeChatPromptCards } from './use-mobile-native-chat-prompt-cards'

let renderer: ReactTestRenderer | undefined
beforeEach(() => mobileNativeChatPromptDismissals.clearForTests())
afterEach(() => act(() => renderer?.unmount()))

it.each([true, false])(
  'keeps the question and failure in sync with acceptance: %s',
  async (accepted) => {
    const answerQuestion = vi.fn(async () => accepted)
    let visibleFailure: string | null = null
    let cards: ReturnType<typeof useMobileNativeChatPromptCards> | undefined
    function Harness(): null {
      const [failure, setFailure] = useState<string | null>('Previous send failed')
      visibleFailure = failure
      cards = useMobileNativeChatPromptCards({
        terminal: {
          permission: null,
          question: {
            question: 'Continue?',
            options: ['Yes'],
            allowOther: false,
            multiSelect: false,
            optionTokens: ['yes']
          },
          waitStartedAt: 1,
          scopeKey: 'host\0workspace\0tab',
          sessionKey: 'session',
          observing: true,
          respondPermission: async () => false,
          answerQuestion,
          handleNativeChatAnswerAsk: async () => false,
          handleNativeChatCancelAsk: async () => false
        },
        structured: null,
        onSendResolved: () => setFailure(null)
      })
      return null
    }
    act(() => {
      renderer = create(createElement(Harness))
    })
    expect(cards?.nativeChatQuestion?.question).toBe('Continue?')
    expect(visibleFailure).toBe('Previous send failed')
    await act(async () => {
      expect(await cards?.handleNativeChatQuestionAnswer('Yes')).toBe(accepted)
    })
    expect(answerQuestion).toHaveBeenCalledExactlyOnceWith('Yes')
    expect(cards?.nativeChatQuestion?.question ?? null).toBe(accepted ? null : 'Continue?')
    expect(visibleFailure).toBe(accepted ? null : 'Previous send failed')
  }
)

it.each([true, false])(
  'routes an async answer and clears only an accepted failure: %s',
  async (accepted) => {
    const bridgeAnswer = vi.fn(async () => false)
    const structuredAnswer = vi.fn(async () => accepted)
    const prompt = {
      questions: [{ question: 'Choose?', options: [{ label: 'Yes' }], multiSelect: false }]
    }
    const answers = [{ indices: [0] }]
    let cards: ReturnType<typeof useMobileNativeChatPromptCards> | undefined
    let visibleFailure: string | null = null
    function Harness(): null {
      const [failure, setFailure] = useState<string | null>('Previous send failed')
      visibleFailure = failure
      cards = useMobileNativeChatPromptCards({
        terminal: {
          permission: null,
          question: null,
          waitStartedAt: null,
          scopeKey: 'async-question',
          sessionKey: 'session',
          observing: true,
          respondPermission: async () => false,
          answerQuestion: async () => false,
          handleNativeChatAnswerAsk: bridgeAnswer,
          handleNativeChatCancelAsk: async () => false
        },
        structured: null,
        structuredAnswer,
        onSendResolved: () => setFailure(null)
      })
      return null
    }
    act(() => {
      renderer = create(createElement(Harness))
    })
    await act(async () => {
      expect(await cards?.handleNativeChatAnswerAsk(prompt, answers)).toBe(accepted)
    })
    expect(structuredAnswer).toHaveBeenCalledExactlyOnceWith(prompt, answers)
    expect(bridgeAnswer).not.toHaveBeenCalled()
    expect(visibleFailure).toBe(accepted ? null : 'Previous send failed')
  }
)
