import { createElement } from 'react'
import TestRenderer from 'react-test-renderer'
import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../src/shared/agent-status-types'
import { useMobileNativeChatPrompts } from './use-mobile-native-chat-prompts'

const APPROVAL = JSON.stringify({
  approval: { tool: 'Bash', summary: 'pnpm build > build.log 2>&1' }
})

function permissionFor(status: Partial<AgentStatusEntry> | null): unknown {
  let captured: unknown
  function Probe(): null {
    captured = useMobileNativeChatPrompts({
      enabled: true,
      status: status as AgentStatusEntry | null,
      messages: []
    }).permission
    return null
  }
  TestRenderer.act(() => {
    TestRenderer.create(createElement(Probe))
  })
  return captured
}

// Keeps one probe mounted across a status change, so the assertion covers a live
// pane whose agent resumed rather than a pane first rendered in the later state.
function permissionAcross(
  before: Partial<AgentStatusEntry>,
  after: Partial<AgentStatusEntry>
): { before: unknown; after: unknown } {
  let captured: unknown
  function Probe({ status }: { status: Partial<AgentStatusEntry> }): null {
    captured = useMobileNativeChatPrompts({
      enabled: true,
      status: status as AgentStatusEntry,
      messages: []
    }).permission
    return null
  }
  let renderer: ReturnType<typeof TestRenderer.create> | undefined
  TestRenderer.act(() => {
    renderer = TestRenderer.create(createElement(Probe, { status: before }))
  })
  const capturedBefore = captured
  TestRenderer.act(() => {
    renderer?.update(createElement(Probe, { status: after }))
  })
  return { before: capturedBefore, after: captured }
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

  it('drops the approval card when a waiting agent resumes on the same pane', () => {
    const permission = permissionAcross(
      { state: 'waiting', interactivePrompt: APPROVAL },
      { state: 'working', interactivePrompt: APPROVAL }
    )

    expect(permission.before).toMatchObject({ title: 'Allow Bash?' })
    expect(permission.after).toBeNull()
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
