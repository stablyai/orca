import { asyncQuestionSourceScope } from '../../../../../src/shared/native-chat/input/native-chat-ask'
import { createElement } from 'react'
import TestRenderer, { type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../../src/shared/agent-status-types'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat-types'
import { useMobileAsyncQuestionHides } from './use-mobile-native-chat-prompt-dismiss'
import { mobileNativeChatPromptDismissals } from './mobile-native-chat-prompt-dismissals'
import { useMobileNativeChatPrompts } from './use-mobile-native-chat-prompts'

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
      asyncSourceScope: 'host/session/epoch',
      hiddenAsyncIds: new Set(),
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
      const notice: NativeChatMessage = {
        id: 'mail',
        role: 'user',
        blocks: [{ type: 'text', text: 'You have 1 orchestration message.' }],
        timestamp: 2,
        source: 'transcript',
        from: {
          kind: 'agent',
          senders: [
            {
              party: { address: 'term_a', terminalHandle: 'term_a', orcaSessionId: null },
              name: 'Coder'
            }
          ],
          orchestration: {
            message: 'mail-notice',
            mailbox: 'term_b',
            dispatchId: null,
            messages: [{ messageId: 'mail-1', runId: 'run-1', from: 'term_a' }]
          }
        }
      }
      let messages = [message]
      let captured: ReturnType<typeof useMobileNativeChatPrompts> | undefined
      function Probe(): null {
        captured = useMobileNativeChatPrompts({
          asyncSourceScope: 'host/session/epoch',
          hiddenAsyncIds: new Set(),
          enabled: true,
          structured: { permission: null, question: null, sendWithOutcome },
          status: null,
          messages,
          transcriptLoading: false
        })
        return null
      }
      let renderer: ReactTestRenderer
      TestRenderer.act(() => {
        renderer = TestRenderer.create(createElement(Probe))
        renderers.push(renderer)
      })
      const initialAsk = captured?.ask
      expect(initialAsk?.questions[0]?.question).toBe('Which color?')
      messages = [message, notice]
      TestRenderer.act(() => renderer.update(createElement(Probe)))

      const ask = captured?.ask
      expect(ask).toEqual(initialAsk)
      expect(ask?.questions[0]?.options.map((option) => option.label)).toEqual(['Red', 'Blue'])
      await expect(ask && captured?.structuredAnswer?.(ask, [{ indices: [1] }])).resolves.toBe(
        accepted
      )
      expect(sendWithOutcome).toHaveBeenCalledWith('> Which color?\n\nBlue')
      messages = [
        ...messages,
        {
          id: 'human-answer',
          role: 'user',
          blocks: [{ type: 'text', text: 'Blue' }],
          timestamp: 3,
          source: 'transcript'
        }
      ]
      TestRenderer.act(() => renderer.update(createElement(Probe)))
      expect(captured?.ask).toBeNull()
    }
  )
})

describe('addressed phone hide subscriptions', () => {
  it('keeps unrelated scopes still and reuses scanner output at N/10N', () => {
    for (const count of [8, 80]) {
      mobileNativeChatPromptDismissals.clearForTests()
      let scans = 0
      const messages: NativeChatMessage[] = [
        {
          ...askMessages[0]!,
          get blocks(): NativeChatMessage['blocks'] {
            scans += 1
            return [
              {
                type: 'tool-call',
                name: 'request_user_input_async',
                input: { questions: [{ title: 'Q1?' }] }
              }
            ]
          }
        }
      ]
      const renders = Array<number>(count).fill(0)
      const actions: (() => void)[] = []
      function Probe({ index }: { index: number }): null {
        renders[index] = (renders[index] ?? 0) + 1
        const sourceKey = asyncQuestionSourceScope({
          kind: 'journal',
          agent: 'codex',
          sessionId: `session-${Math.floor(index / 2)}`,
          epoch: 'epoch'
        })
        const hides = useMobileAsyncQuestionHides(
          `host-${index % 2}/pane-${Math.floor(index / 2)}`,
          sourceKey,
          'view'
        )
        const prompts = useMobileNativeChatPrompts({
          enabled: true,
          status: null,
          messages,
          transcriptLoading: false,
          asyncSourceScope: sourceKey,
          hiddenAsyncIds: hides.hidden
        })
        actions[index] = hides.capture(prompts.ask?.occurrenceIds ?? [])
        return null
      }
      let renderer: ReactTestRenderer
      TestRenderer.act(() => {
        renderer = TestRenderer.create(
          createElement(
            'Probes',
            null,
            Array.from({ length: count }, (_, index) => createElement(Probe, { key: index, index }))
          )
        )
        renderers.push(renderer)
      })
      const initialScans = scans
      expect(initialScans).toBeGreaterThanOrEqual(count)
      expect(initialScans).toBeLessThanOrEqual(2 * count)
      renders.fill(0)
      TestRenderer.act(() => actions[0]!())
      expect(renders).toEqual([1, ...Array<number>(count - 1).fill(0)])
      expect(scans).toBe(initialScans)
      renders.fill(0)
      TestRenderer.act(() => actions[1]!())
      expect(renders).toEqual([0, 1, ...Array<number>(count - 2).fill(0)])
      expect(scans).toBe(initialScans)
      renders.fill(0)
      TestRenderer.act(() => actions[0]!())
      expect(renders.every((value) => value === 0)).toBe(true)
      TestRenderer.act(() => renderer.unmount())
      renderers.pop()
    }
  })
})
