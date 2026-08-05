import { createElement } from 'react'
import TestRenderer from 'react-test-renderer'
import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../src/shared/agent-status-types'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { useMobileNativeChatPrompts } from './use-mobile-native-chat-prompts'

const APPROVAL = JSON.stringify({
  approval: { tool: 'Bash', summary: 'pnpm build > build.log 2>&1' }
})

const ASK = JSON.stringify({
  questions: [{ question: 'Which path?', options: ['fast', 'safe'] }]
})

function promptsFor(
  status: Partial<AgentStatusEntry> | null,
  messages: NativeChatMessage[] = []
): ReturnType<typeof useMobileNativeChatPrompts> {
  let captured: ReturnType<typeof useMobileNativeChatPrompts> | undefined
  function Probe(): null {
    captured = useMobileNativeChatPrompts({
      enabled: true,
      status: status as AgentStatusEntry | null,
      messages
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
