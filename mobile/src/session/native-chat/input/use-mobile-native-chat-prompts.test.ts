import { createElement } from 'react'
import TestRenderer, { type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../../src/shared/agent-status-types'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat-types'
import { useMobileNativeChatPrompts } from './use-mobile-native-chat-prompts'
import { useMobileNativeChatAskDismiss } from './use-mobile-native-chat-ask-dismiss'
import { mobileNativeChatPromptDismissals } from './mobile-native-chat-prompt-dismissals'

const renderers: ReactTestRenderer[] = []
afterEach(() => {
  TestRenderer.act(() => {
    for (const renderer of renderers) {
      renderer.unmount()
    }
  })
  renderers.length = 0
})

const APPROVAL = JSON.stringify({
  approval: { tool: 'Bash', summary: 'pnpm build > build.log 2>&1' }
})

const ASK = JSON.stringify({
  questions: [{ question: 'Which path?', options: ['fast', 'safe'] }]
})

function promptsFor(
  status: Partial<AgentStatusEntry> | null,
  messages: NativeChatMessage[] = [],
  transcriptLoading = false
): ReturnType<typeof useMobileNativeChatPrompts> {
  let captured: ReturnType<typeof useMobileNativeChatPrompts> | undefined
  function Probe(): null {
    captured = useMobileNativeChatPrompts({
      enabled: true,
      status: status as AgentStatusEntry | null,
      messages,
      transcriptLoading
    })
    return null
  }
  TestRenderer.act(() => {
    renderers.push(TestRenderer.create(createElement(Probe)))
  })
  return captured!
}

const askMessages: NativeChatMessage[] = [
  {
    id: 'm1',
    role: 'assistant',
    blocks: [
      {
        type: 'tool-call',
        name: 'AskUserQuestion',
        input: { questions: [{ question: 'Which path?', options: ['fast', 'safe'] }] }
      }
    ],
    timestamp: 0,
    source: 'transcript'
  }
]

describe('useMobileNativeChatPrompts terminal cards', () => {
  it('never guesses a card from assistant prose', () => {
    const prompts = promptsFor({
      state: 'waiting',
      lastAssistantMessage: 'Allow this Bash command?\n1. Yes\n2. No'
    })
    expect(prompts.permission).toBeNull()
    expect(prompts.ask).toBeNull()
  })

  it.each(['waiting', 'working', 'done'] as const)(
    'shows a status approval or ask while the agent is %s, as desktop does',
    (state) => {
      expect(promptsFor({ state, interactivePrompt: APPROVAL }).permission).toMatchObject({
        title: 'Allow Bash?',
        detail: 'pnpm build > build.log 2>&1'
      })
      expect(promptsFor({ state, interactivePrompt: ASK }).ask).toMatchObject({
        questions: [{ question: 'Which path?' }]
      })
    }
  )

  it('stamps only a status-backed card with its wait start', () => {
    expect(
      promptsFor({ state: 'waiting', interactivePrompt: ASK, stateStartedAt: 10 }).waitStartedAt
    ).toBe(10)
    expect(promptsFor({ state: 'waiting', stateStartedAt: 10 }, askMessages).waitStartedAt).toBe(
      null
    )
  })
})

describe('useMobileNativeChatPrompts transcript asks', () => {
  it('keeps a pending transcript ask whatever the status says', () => {
    // Stale status loses interactivePrompt; transcript pending asks must remain answerable until their tool result lands.
    expect(promptsFor({ state: 'done' }, askMessages).ask).not.toBeNull()
    expect(promptsFor(null, askMessages).ask).not.toBeNull()
  })

  it('withholds retained transcript asks while the replacement read is unsettled', () => {
    expect(promptsFor({ state: 'done' }, askMessages, true).ask).toBeNull()
  })

  it('keeps a live status ask while the read is unsettled', () => {
    const prompts = promptsFor({ state: 'waiting', interactivePrompt: ASK }, askMessages, true)
    expect(prompts.ask).toMatchObject({ questions: [{ question: 'Which path?' }] })
  })

  it('drops a transcript ask once its result lands', () => {
    const answered: NativeChatMessage[] = [
      ...askMessages,
      {
        id: 'm2',
        role: 'tool',
        blocks: [{ type: 'tool-result', output: 'fast' }],
        timestamp: 1,
        source: 'transcript'
      }
    ]
    expect(promptsFor({ state: 'done' }, answered).ask).toBeNull()
  })
})

describe('useMobileNativeChatPrompts in a structured chat', () => {
  it.each([
    ['accepted', true],
    ['queued', true],
    ['unknown', true],
    ['rejected', false]
  ] as const)(
    'answers a Codex async question through an ordinary %s send',
    async (outcome, accepted) => {
      const sendWithOutcome = vi.fn(async () => outcome)
      const questions = [{ title: 'Which color?', options: ['Red', 'Blue'] }]
      const message: NativeChatMessage = {
        id: 'ask',
        role: 'assistant',
        blocks: [
          { type: 'text', text: 'Which color?\n- Red\n- Blue' },
          { type: 'tool-call', name: 'request_user_input_async', input: { questions } }
        ],
        timestamp: null,
        source: 'transcript'
      }
      let captured: ReturnType<typeof useMobileNativeChatPrompts> | undefined
      function Probe(): null {
        captured = useMobileNativeChatPrompts({
          enabled: true,
          structured: { permission: null, question: null, sendWithOutcome },
          status: null,
          messages: [message],
          transcriptLoading: false
        })
        return null
      }
      TestRenderer.act(() => {
        renderers.push(TestRenderer.create(createElement(Probe)))
      })

      const ask = captured?.ask
      expect(ask?.questions[0]?.question).toBe('Which color?')
      await expect(ask && captured?.structuredAnswer?.(ask, [{ indices: [1] }])).resolves.toBe(
        accepted
      )
      expect(sendWithOutcome).toHaveBeenCalledWith('> Which color?\n\nBlue')
    }
  )
})

describe('structured async question occurrences', () => {
  it.each([undefined, 'reused-call'])(
    'shows an identical question after a delivered answer without an empty read (call ID: %s)',
    async (callId) => {
      mobileNativeChatPromptDismissals.clearForTests()
      const sendWithOutcome = vi.fn(async () => 'accepted' as const)
      const structured = { permission: null, question: null, sendWithOutcome }
      const first: NativeChatMessage = {
        id: 'ask',
        role: 'assistant',
        timestamp: null,
        source: 'transcript',
        blocks: [
          {
            type: 'tool-call',
            name: 'request_user_input_async',
            callId,
            input: { questions: [{ title: 'Which color?', options: ['Red', 'Blue'] }] }
          }
        ]
      }
      let prompts: ReturnType<typeof useMobileNativeChatPrompts>
      let dismissal: ReturnType<typeof useMobileNativeChatAskDismiss>
      function Probe({ messages }: { messages: NativeChatMessage[] }): null {
        prompts = useMobileNativeChatPrompts({
          enabled: true,
          structured,
          status: null,
          messages,
          transcriptLoading: false
        })
        dismissal = useMobileNativeChatAskDismiss({
          ask: prompts.ask,
          startedAt: prompts.waitStartedAt,
          scopeKey: 'async-tab',
          sessionKey: 'session',
          observing: true
        })
        return null
      }
      let renderer: ReactTestRenderer
      TestRenderer.act(() => {
        renderer = TestRenderer.create(createElement(Probe, { messages: [first] }))
        renderers.push(renderer)
      })
      const update = (messages: NativeChatMessage[]) =>
        TestRenderer.act(() => renderer.update(createElement(Probe, { messages })))
      TestRenderer.act(() => dismissal.dismissAsk())
      expect(dismissal!.showAsk).toBe(false)
      expect(sendWithOutcome).not.toHaveBeenCalled()
      for (const readbackId of ['resumed-call', undefined]) {
        update([
          {
            ...first,
            blocks: [
              { type: 'text', text: 'More context' },
              ...first.blocks.map((block) =>
                block.type === 'tool-call' ? { ...block, callId: readbackId } : block
              )
            ]
          }
        ])
        expect(dismissal!.showAsk).toBe(false)
      }

      const answer: NativeChatMessage = {
        id: 'answer',
        role: 'user',
        timestamp: null,
        source: 'transcript',
        blocks: [{ type: 'text', text: 'Blue' }]
      }
      const second = { ...first, id: 'ask-again' }
      update([first, answer, second])
      expect(dismissal!.showAsk).toBe(true)
      await TestRenderer.act(async () => {
        if (await prompts.structuredAnswer?.(prompts.ask!, [{ indices: [1] }])) {
          dismissal.dismissAsk()
        }
      })
      expect(sendWithOutcome).toHaveBeenCalledWith('> Which color?\n\nBlue')
      expect(dismissal!.showAsk).toBe(false)
      update([
        first,
        answer,
        second,
        { ...answer, id: 'second-answer' },
        { ...first, id: 'third-ask' }
      ])
      expect(dismissal!.showAsk).toBe(true)
    }
  )
})

it('uses host async controls with no loaded row on both phone input paths', async () => {
  const prompt = {
    replyAsMessage: true as const,
    occurrenceKey: '["host-row"]',
    questions: [
      {
        question: 'Which color?',
        multiSelect: false,
        options: [{ label: 'Red' }, { label: 'Blue' }]
      }
    ]
  }
  const sendWithOutcome = vi.fn(async () => 'accepted' as const)
  for (const structured of [
    null,
    { permission: null, question: null, sendWithOutcome, asyncQuestion: prompt }
  ]) {
    let captured: ReturnType<typeof useMobileNativeChatPrompts> | undefined
    function Probe(): null {
      captured = useMobileNativeChatPrompts({
        enabled: true,
        structured,
        asyncQuestion: prompt,
        status: null,
        messages: [],
        transcriptLoading: false
      })
      return null
    }
    TestRenderer.act(() => {
      renderers.push(TestRenderer.create(createElement(Probe)))
    })
    expect(captured?.ask).toEqual(prompt)
    if (structured) {
      await expect(captured?.structuredAnswer?.(prompt, [{ indices: [1] }])).resolves.toBe(true)
    }
  }
  expect(sendWithOutcome).toHaveBeenCalledWith('> Which color?\n\nBlue')
})
