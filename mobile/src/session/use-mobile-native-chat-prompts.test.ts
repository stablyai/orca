import { createElement } from 'react'
import TestRenderer from 'react-test-renderer'
import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../src/shared/agent-status-types'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import type { NativeChatAsyncQuestionsView } from '../../../src/shared/native-chat-async-questions'
import { useMobileNativeChatPrompts } from './use-mobile-native-chat-prompts'

const APPROVAL = JSON.stringify({
  approval: { tool: 'Bash', summary: 'pnpm build > build.log 2>&1' }
})

const ASK = JSON.stringify({
  questions: [{ question: 'Which path?', options: ['fast', 'safe'] }]
})

function promptsFor(
  status: Partial<AgentStatusEntry> | null,
  messages: NativeChatMessage[] = [],
  transcriptLoading = false,
  asyncQuestions: NativeChatAsyncQuestionsView = { state: 'absent' }
): ReturnType<typeof useMobileNativeChatPrompts> {
  let captured: ReturnType<typeof useMobileNativeChatPrompts> | undefined
  function Probe(): null {
    captured = useMobileNativeChatPrompts({
      enabled: true,
      status: status as AgentStatusEntry | null,
      messages,
      transcriptLoading,
      asyncQuestions
    })
    return null
  }
  TestRenderer.act(() => {
    TestRenderer.create(createElement(Probe))
  })
  return captured!
}

function permissionFor(status: Partial<AgentStatusEntry> | null): unknown {
  return promptsFor(status).permission
}

describe('useMobileNativeChatPrompts approval-envelope state gate', () => {
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

  it('puts the shared envelope ahead of the numbered-prose guess while paused', () => {
    const { permission } = promptsFor({
      state: 'waiting',
      interactivePrompt: APPROVAL,
      lastAssistantMessage: 'Allow this Bash command?\n1. Yes\n2. No'
    })
    expect(permission?.title).toBe('Allow Bash?')
    expect(permission?.options.map((o) => o.label)).toEqual(['Allow', 'Deny'])
  })

  it('shows Claude terminal ExitPlanMode as the approval, never plan steps as buttons', () => {
    const prompts = promptsFor({
      state: 'waiting',
      agentType: 'claude',
      interactivePrompt: JSON.stringify({ approval: { tool: 'ExitPlanMode', summary: 'plan' } }),
      lastAssistantMessage: 'Would you like to proceed?\n1. Add the API\n2. Write tests'
    })
    expect(prompts.permission?.title).toBe('Allow ExitPlanMode?')
    expect(prompts.permission?.options.map((option) => option.label)).toEqual(['Allow', 'Deny'])
    expect(prompts.question).toBeNull()
  })

  it('shows an unsupported envelope with its own words and no options, and guesses nothing', () => {
    const prompts = promptsFor({
      state: 'blocked',
      agentType: 'codex',
      interactivePrompt: JSON.stringify({ choice: { title: 'Implement this plan?' } }),
      lastAssistantMessage: 'Implement this plan?\n1. Yes, implement\n2. No, keep planning'
    })
    expect(prompts.permission).toMatchObject({
      title: 'Implement this plan?',
      description: 'This request needs a newer version of Orca.',
      options: []
    })
    expect(prompts.question).toBeNull()
  })
})

describe('useMobileNativeChatPrompts with a prompt that is not an envelope', () => {
  it.each([
    ['a truncated prompt', '{"questions":[{"question":"Implement'],
    ['raw tool input', JSON.stringify({ action: 'delete the bucket', reason: 'cleanup' })]
  ])(
    'keeps today\'s behaviour for %s: no "newer version" card, the guess still runs',
    (_case, prompt) => {
      const prompts = promptsFor({
        state: 'waiting',
        interactivePrompt: prompt,
        lastAssistantMessage: 'Allow this Bash command?\n1. Yes\n2. No'
      })
      expect(prompts.permission?.description).not.toBe(
        'This request needs a newer version of Orca.'
      )
      expect(prompts.permission?.options.map((option) => option.label)).toEqual(['Yes', 'No'])
    }
  )
})

describe('useMobileNativeChatPrompts with Codex async questions', () => {
  const prose = 'Which color would you like to use?\n1. Red\n2. Blue'
  const blocked = { state: 'blocked' as const, agentType: 'codex', lastAssistantMessage: prose }

  it('makes no guess from async prose while the host lists the question', () => {
    const prompts = promptsFor(blocked, [], false, {
      state: 'ready',
      questions: [{ key: 'k', index: 0, title: 'Which color would you like to use?' }]
    })
    expect(prompts.permission).toBeNull()
    expect(prompts.question).toBeNull()
  })

  it('makes no guess while the host is still deriving the set', () => {
    const prompts = promptsFor(blocked, [], false, { state: 'pending' })
    expect(prompts.permission).toBeNull()
    expect(prompts.question).toBeNull()
  })

  it('keeps the prose guesses for an older host that publishes nothing', () => {
    expect(promptsFor(blocked).permission).not.toBeNull()
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
    // The prompt payload outlives its answer — same paused gate as permission.
    const working = promptsFor({ state: 'working', interactivePrompt: ASK })
    expect(working.ask).toBeNull()
    expect(working.detectedAsk).not.toBeNull()

    const done = promptsFor({ state: 'done', interactivePrompt: ASK })
    expect(done.ask).toBeNull()
    expect(done.detectedAsk).not.toBeNull()
  })

  it('keeps the transcript-derived pending ask outside the paused gate', () => {
    // A hook row idle past AGENT_STATUS_STALE_AFTER_MS projects to `done` with no
    // interactivePrompt, so gating this too would make a still-pending question
    // unanswerable from mobile. `extractPendingAsk` clears on the tool result.
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
    // The post-answer window: the status still carries the prompt while flipping
    // to `working`, and the transcript's tool-result row has not landed yet, so
    // both sources still describe the answered question. The paused gate only
    // holds because a status prompt suppresses the transcript fallback outright.
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
