import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../src/shared/agent-status-types'
import { useMobileNativeChatPrompts } from './use-mobile-native-chat-prompts'

const APPROVAL = JSON.stringify({
  approval: { tool: 'Bash', summary: 'chmod 644 alpha.txt' }
})

describe('useMobileNativeChatPrompts', () => {
  let renderer: ReactTestRenderer | null = null
  let prompts: ReturnType<typeof useMobileNativeChatPrompts> | null = null

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    prompts = null
  })

  function Harness({ status }: { status: AgentStatusEntry | null }): null {
    prompts = useMobileNativeChatPrompts({ enabled: true, status, messages: [] })
    return null
  }

  function render(status: Partial<AgentStatusEntry> | null): void {
    act(() => {
      renderer = create(createElement(Harness, { status: status as AgentStatusEntry | null }))
    })
  }

  function renderWithState(state: AgentStatusEntry['state']): void {
    render({ state, interactivePrompt: APPROVAL })
  }

  function updateState(state: AgentStatusEntry['state']): void {
    act(() => {
      renderer?.update(
        createElement(Harness, {
          status: { state, interactivePrompt: APPROVAL } as unknown as AgentStatusEntry
        })
      )
    })
  }

  it('offers the approval card while the agent is waiting on it', () => {
    renderWithState('waiting')

    expect(prompts?.permission).toMatchObject({ title: 'Allow Bash?' })
  })

  it('offers the approval card while the agent is blocked', () => {
    renderWithState('blocked')

    expect(prompts?.permission).toMatchObject({ title: 'Allow Bash?' })
  })

  it('drops the approval card once the agent is working again', () => {
    renderWithState('working')

    expect(prompts?.permission).toBeNull()
  })

  it('drops the approval card once the turn is done', () => {
    renderWithState('done')

    expect(prompts?.permission).toBeNull()
  })

  // The envelope survives the wait it belongs to, so the card has to go on the
  // transition itself, not only when the pane is mounted fresh in a later state.
  it('drops the approval card when a waiting agent resumes on the same pane', () => {
    renderWithState('waiting')
    expect(prompts?.permission).toMatchObject({ title: 'Allow Bash?' })

    updateState('working')

    expect(prompts?.permission).toBeNull()
  })

  it('drops the approval card when there is no status at all', () => {
    render(null)

    expect(prompts?.permission).toBeNull()
  })

  // Both producers can fire on one paused status; the parsed prompt text carries
  // the agent's real options, so it has to win over the envelope's guessed ones.
  it('prefers the parsed numbered options over the envelope defaults', () => {
    render({
      state: 'waiting',
      interactivePrompt: APPROVAL,
      lastAssistantMessage: 'Do you want to proceed?\n1. Yes\n2. No, and tell Claude what to do'
    })

    expect(prompts?.permission).toMatchObject({
      title: 'Permission requested',
      options: [
        { label: 'Yes', send: '1' },
        { label: 'No, and tell Claude what to do', send: '2' }
      ]
    })
  })
})
