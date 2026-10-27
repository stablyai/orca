import { createElement } from 'react'
import TestRenderer, { type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../../src/shared/agent-status-types'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat-types'
import { buildOmpPlanReviewAnswer } from '../../../../../src/shared/omp-plan-review-prompt'
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

function permissionFor(status: Partial<AgentStatusEntry> | null): unknown {
  return promptsFor(status).permission
}

describe('useMobileNativeChatPrompts approval-envelope state gate', () => {
  it('keeps the OMP plan review card authoritative over approval-sounding prose', () => {
    const planReview = JSON.stringify({
      planReview: {
        reviewId: 'review-1',
        plan: '# Plan',
        options: [{ id: 'execute', label: 'Approve and execute' }]
      }
    })
    expect(
      permissionFor({
        state: 'blocked',
        agentType: 'omp',
        interactivePrompt: planReview,
        lastAssistantMessage: 'Please approve this plan.\n1. Yes\n2. No'
      })
    ).toMatchObject({
      subject: { kind: 'plan', text: '# Plan' },
      options: [
        { label: 'Approve and execute', send: buildOmpPlanReviewAnswer('review-1', 'execute') }
      ]
    })
  })

  it.each(['opencode', 'opencode2'])(
    'keeps the %s approval event authoritative over numbered assistant prose',
    (agentType) => {
      expect(
        permissionFor({
          state: 'waiting',
          agentType,
          interactivePrompt: APPROVAL,
          lastAssistantMessage: 'Allow this Bash command?\n1. Yes\n2. No'
        })
      ).toMatchObject({
        title: 'Allow Bash?',
        options: [
          { label: 'Allow', send: '\r' },
          { label: 'Deny', send: '\x1b' }
        ]
      })
    }
  )

  it.each(['opencode', 'opencode2'])(
    'does not mistake %s question text for an approval',
    (agentType) => {
      const prompts = promptsFor({
        state: 'waiting',
        agentType,
        interactivePrompt: ASK,
        lastAssistantMessage: 'Allow this Bash command?\n1. Yes\n2. No'
      })
      expect(prompts.permission).toBeNull()
      expect(prompts.ask?.questions[0]?.question).toBe('Which path?')
    }
  )
  it('renders no approval card while the agent is working', () => {
    expect(permissionFor({ state: 'working', interactivePrompt: APPROVAL })).toBeNull()
  })

  it('renders no approval card after the turn is done', () => {
    expect(permissionFor({ state: 'done', interactivePrompt: APPROVAL })).toBeNull()
  })

  it('renders no approval card without a status', () => {
    expect(permissionFor(null)).toBeNull()
  })

  it('renders the approval card while the agent is waiting', () => {
    expect(permissionFor({ state: 'waiting', interactivePrompt: APPROVAL })).toMatchObject({
      title: 'Allow Bash?',
      detail: 'pnpm build > build.log 2>&1'
    })
  })

  it('renders the approval card while the agent is blocked', () => {
    expect(permissionFor({ state: 'blocked', interactivePrompt: APPROVAL })).toMatchObject({
      title: 'Allow Bash?'
    })
  })

  it('prefers the heuristic numbered menu over the envelope while paused', () => {
    const permission = permissionFor({
      state: 'waiting',
      interactivePrompt: APPROVAL,
      lastAssistantMessage: 'Allow this Bash command?\n1. Yes\n2. No'
    }) as { options: Array<{ label: string }> } | null
    expect(permission).toMatchObject({ title: 'Permission requested' })
    expect(permission?.options.map((o) => o.label)).toEqual(['Yes', 'No'])
  })
})

describe('useMobileNativeChatPrompts ask state gate', () => {
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

  it('renders the ask card only while the agent is waiting or blocked', () => {
    expect(promptsFor({ state: 'waiting', interactivePrompt: ASK }).ask).toMatchObject({
      questions: [{ question: 'Which path?' }]
    })
    expect(promptsFor({ state: 'blocked', interactivePrompt: ASK }).ask).not.toBeNull()
  })

  it('renders no ask card from a sticky prompt while the agent is working or done', () => {
    const working = promptsFor({ state: 'working', interactivePrompt: ASK })
    expect(working.ask).toBeNull()
    expect(working.detectedAsk).not.toBeNull()

    const done = promptsFor({ state: 'done', interactivePrompt: ASK })
    expect(done.ask).toBeNull()
    expect(done.detectedAsk).not.toBeNull()
  })

  it('keeps the transcript-derived pending ask outside the paused gate', () => {
    // Stale status loses interactivePrompt; transcript pending asks must remain answerable until their tool result lands.
    expect(promptsFor({ state: 'waiting' }, askMessages).ask).not.toBeNull()
    expect(promptsFor({ state: 'done' }, askMessages).ask).not.toBeNull()
    expect(promptsFor({ state: 'working' }, askMessages).ask).not.toBeNull()
    expect(promptsFor(null, askMessages).ask).not.toBeNull()
  })

  it('withholds retained transcript asks while the replacement read is unsettled', () => {
    const prompts = promptsFor({ state: 'done' }, askMessages, true)
    expect(prompts.ask).toBeNull()
    expect(prompts.detectedAsk).toBeNull()
  })

  it('keeps a paused live status ask authoritative while the read is unsettled', () => {
    const prompts = promptsFor({ state: 'waiting', interactivePrompt: ASK }, askMessages, true)
    expect(prompts.ask).toMatchObject({ questions: [{ question: 'Which path?' }] })
    expect(prompts.detectedAsk).not.toBeNull()
  })

  it('does not leak a paused-out sticky status prompt through the transcript fallback', () => {
    // Sticky answered status suppresses transcript fallback; only the paused gate prevents a duplicate card while its result is in flight.
    const working = promptsFor({ state: 'working', interactivePrompt: ASK }, askMessages)
    expect(working.ask).toBeNull()
    expect(working.detectedAsk).not.toBeNull()
  })

  it('still refuses an unpaused sticky status prompt that the transcript does not back', () => {
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
    expect(promptsFor({ state: 'done', interactivePrompt: ASK }, answered).ask).toBeNull()
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
