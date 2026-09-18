import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../src/shared/agent-status-types'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { useMobileNativeChatPrompts } from './use-mobile-native-chat-prompts'
import { useMobileNativeChatAskDismiss } from './use-mobile-native-chat-ask-dismiss'
import { extractMobileAsyncAsk } from './mobile-native-chat-async-ask'

const asyncInput = {
  questions: [
    { title: 'Which color?', options: ['Red (Recommended)', 'Blue'] },
    { title: 'Any constraints?' }
  ]
}
const call: NativeChatMessage = {
  id: 'ask',
  role: 'assistant',
  timestamp: 1,
  source: 'transcript',
  blocks: [
    {
      type: 'tool-call',
      name: 'request_user_input_async',
      callId: 'async-1',
      input: JSON.stringify(asyncInput)
    }
  ]
}
const accepted: NativeChatMessage = {
  id: 'accepted',
  role: 'tool',
  timestamp: 2,
  source: 'transcript',
  blocks: [{ type: 'tool-result', output: '{"accepted":true}' }]
}
const completed: NativeChatMessage = {
  id: 'async-1',
  role: 'assistant',
  timestamp: 2,
  source: 'transcript',
  blocks: [{ type: 'text', text: 'Which color?\n- Red (Recommended)\n- Blue\n\nAny constraints?' }]
}

describe('mobile async Codex question visibility', () => {
  let renderer: ReactTestRenderer | null = null
  let prompts: ReturnType<typeof useMobileNativeChatPrompts>
  let dismissal: ReturnType<typeof useMobileNativeChatAskDismiss>
  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  function Harness({
    messages,
    loading = false,
    status = null
  }: {
    messages: NativeChatMessage[]
    loading?: boolean
    status?: Partial<AgentStatusEntry> | null
  }) {
    prompts = useMobileNativeChatPrompts({
      enabled: true,
      status: status as AgentStatusEntry | null,
      messages,
      transcriptLoading: loading
    })
    dismissal = useMobileNativeChatAskDismiss({
      ask: prompts.ask,
      detectedAsk: prompts.detectedAsk,
      scopeKey: 'tab',
      sessionKey: 'session',
      observing: !loading
    })
    return null
  }

  async function render(
    messages: NativeChatMessage[],
    loading = false,
    status: Partial<AgentStatusEntry> | null = null
  ) {
    await act(async () => {
      const element = createElement(Harness, { messages, loading, status })
      if (renderer) {
        renderer.update(element)
      } else {
        renderer = create(element)
      }
    })
  }

  it.each(['working', 'done'] as const)(
    'dismisses the async card despite a sticky blocking prompt while %s',
    async (state) => {
      const status = {
        state,
        interactivePrompt: JSON.stringify({
          questions: [{ question: 'Old blocking question', options: ['A', 'B'] }]
        })
      }
      const history = [call, completed, accepted]
      await render(history, false, status)
      expect(prompts.ask?.questions[0].question).toBe('Which color?')
      expect(dismissal.showAsk).toBe(true)
      act(() => dismissal.dismissAsk())
      expect(dismissal.showAsk).toBe(false)

      await render(history, true, status)
      await render(history, false, status)
      expect(dismissal.showAsk).toBe(false)
    }
  )

  it('shows titles, choices and free text after immediate acceptance while the agent continues', async () => {
    await render([call, completed, accepted])
    expect(prompts.ask?.questions).toEqual([
      {
        question: 'Which color?',
        multiSelect: false,
        options: [{ label: 'Red (Recommended)' }, { label: 'Blue' }]
      },
      { question: 'Any constraints?', multiSelect: false, options: [] }
    ])
    expect(prompts.permission).toBeNull()
    await render([
      call,
      completed,
      accepted,
      { ...call, id: 'exec', blocks: [{ type: 'tool-call', name: 'exec_command', input: '{}' }] },
      accepted
    ])
    expect(prompts.ask?.questions).toHaveLength(2)
  })

  it('withholds a cached card during reconnect and restores it after replay settles', async () => {
    await render([call, completed, accepted], true)
    expect(prompts.ask).toBeNull()
    await render([call, completed, accepted])
    expect(prompts.ask?.questions[0].question).toBe('Which color?')
    await render([
      call,
      completed,
      accepted,
      {
        id: 'answer',
        role: 'user',
        timestamp: 3,
        source: 'transcript',
        blocks: [{ type: 'text', text: 'Which color? Blue' }]
      }
    ])
    expect(prompts.ask).toBeNull()
  })

  it('needs loaded call history and recovers the card when earlier messages are loaded', async () => {
    const later = Array.from({ length: 40 }, (_, index) => ({ ...accepted, id: `later-${index}` }))
    const history = [call, completed, accepted, ...later]
    await render(history.slice(-40))
    expect(prompts.ask).toBeNull()
    await render(history)
    expect(prompts.ask?.questions).toHaveLength(2)
  })

  it('does not infer acceptance from a result or an unrelated assistant message', () => {
    expect(extractMobileAsyncAsk([call, accepted])).toBeNull()
    expect(extractMobileAsyncAsk([call, { ...completed, id: 'unrelated' }, accepted])).toBeNull()
  })

  it.each([
    '{broken',
    '{"questions":[]}',
    '{"questions":[{"title":"","options":["A"]}]}',
    '{"questions":[{"title":"Choose","options":["A",null]}]}'
  ])('leaves malformed input as ordinary transcript content: %s', (input) => {
    const malformed = {
      ...call,
      blocks: [
        { type: 'tool-call' as const, name: 'request_user_input_async', callId: 'async-1', input }
      ]
    }
    expect(extractMobileAsyncAsk([malformed, completed, accepted])).toBeNull()
  })
})
