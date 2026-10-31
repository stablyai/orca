import { createElement } from 'react'
import TestRenderer from 'react-test-renderer'
import { expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat-types'
import { projectStructuredItemToNativeChat } from '../../../../../src/shared/structured-agent-session-projection'
import { useMobileNativeChatPrompts } from './use-mobile-native-chat-prompts'

it('retains a terminal blocking ask across a projected notice until its result', () => {
  // Mixed-source hook contract, not a captured shipping delivery: Claude-shaped call plus projected journal row.
  const asked: NativeChatMessage = {
    id: 'ask',
    role: 'assistant',
    timestamp: 1,
    source: 'transcript',
    blocks: [
      {
        type: 'tool-call',
        name: 'AskUserQuestion',
        input: { questions: [{ question: 'Which path?', options: ['fast', 'safe'] }] }
      }
    ]
  }
  const notice = projectStructuredItemToNativeChat({
    itemId: 'notice',
    sequence: 2,
    revision: 1,
    observedAt: 2,
    body: {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'Agent update' }],
      from: { kind: 'agent', senders: [], orchestration: null }
    }
  })!
  let prompts: ReturnType<typeof useMobileNativeChatPrompts> | undefined
  function Probe({ messages }: { messages: NativeChatMessage[] }): null {
    prompts = useMobileNativeChatPrompts({
      enabled: true,
      status: null,
      messages,
      transcriptLoading: false,
      asyncSourceScope: 'host/session',
      hiddenAsyncIds: new Set()
    })
    return null
  }
  let view!: TestRenderer.ReactTestRenderer
  try {
    TestRenderer.act(() => {
      view = TestRenderer.create(createElement(Probe, { messages: [asked] }))
    })
    const pending = prompts?.ask
    expect(pending?.questions[0]?.question).toBe('Which path?')
    TestRenderer.act(() => {
      view.update(createElement(Probe, { messages: [asked, notice] }))
    })
    expect(prompts?.ask).toEqual(pending)
    TestRenderer.act(() => {
      view.update(
        createElement(Probe, {
          messages: [
            asked,
            notice,
            {
              id: 'result',
              role: 'tool',
              timestamp: 3,
              source: 'transcript',
              blocks: [{ type: 'tool-result', output: 'fast' }]
            }
          ]
        })
      )
    })
    expect(prompts?.ask).toBeNull()
  } finally {
    TestRenderer.act(() => view?.unmount())
  }
})
