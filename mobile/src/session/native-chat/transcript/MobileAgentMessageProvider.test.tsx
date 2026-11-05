import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import './mobile-agent-message-renderer.test-fixture'
import { describe, expect, it } from 'vitest'
import { parseOrcaSessionAddress } from '../../../../../src/shared/orca-session-address'
import {
  createMobileAgentMessageSource,
  useMobileAgentMessageView
} from './mobile-agent-message-context'
import type { MobileSessionTab } from '../../mobile-session-route-types'

describe('saved sender activity', () => {
  it('keeps the saved kind without a provider and after its tab closes', async () => {
    const session = parseOrcaSessionAddress('orca_session_id:codex_original_sender')
    if (!session) {
      throw new Error('invalid fixture session')
    }
    const sender = {
      name: 'Original sender',
      agent: 'codex',
      party: { address: 'term_old', terminalHandle: 'term_old', orcaSessionId: session }
    }
    let value: ReturnType<typeof useMobileAgentMessageView> | undefined
    function Probe() {
      value = useMobileAgentMessageView(sender)
      return null
    }
    let renderer: ReactTestRenderer | undefined
    await act(async () => {
      renderer = create(createElement(Probe))
    })
    expect(value).toEqual({ agentType: 'codex' })
    await act(async () => renderer?.unmount())
    const source = createMobileAgentMessageSource()
    const tab: MobileSessionTab = {
      type: 'agent-session',
      id: 'chat',
      sessionId: session,
      agent: 'codex',
      title: 'Original sender',
      isActive: true,
      chatStatus: { state: 'working', updatedAt: 1000 }
    }
    source.update([tab], [], 1000)
    expect(source.view(sender)).toMatchObject({ agentType: 'codex', dot: 'working' })
    act(() => source.update([], [], 1000))
    expect(source.view(sender)).toEqual({ agentType: 'codex' })
  })

  it('never takes terminal activity for ordinary mail, a Dispatch or a missing saved session', () => {
    const source = createMobileAgentMessageSource()
    const tab: MobileSessionTab = {
      type: 'terminal',
      id: 'terminal',
      terminal: 'term_old',
      launchAgent: 'codex',
      title: 'Later sender',
      isActive: true,
      agentStatus: {
        paneKey: 'tab:leaf',
        worktreeId: 'workspace',
        terminalHandle: 'term_old',
        agentType: 'codex',
        state: 'working',
        updatedAt: 1000,
        prompt: 'work',
        stateStartedAt: 1000,
        stateHistory: []
      }
    }
    source.update([tab], [{ handle: 'term_old', agentIdentity: 'codex' }], 1000)
    const session = parseOrcaSessionAddress('orca_session_id:codex_original_sender')
    if (!session) {
      throw new Error('invalid fixture session')
    }
    for (const party of [
      { address: 'term_old', terminalHandle: 'term_old', orcaSessionId: null },
      { address: 'dispatch:past', terminalHandle: 'term_old', orcaSessionId: null },
      { address: 'term_old', terminalHandle: 'term_old', orcaSessionId: session }
    ]) {
      const sender = { name: 'Original sender', agent: 'codex', party }
      expect(source.view(sender)).toEqual({ agentType: 'codex' })
      expect(source.view(sender)).toBe(source.view(sender))
    }
  })
})
