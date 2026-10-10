import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../src/shared/protocol-version'
import { describe, expect, it } from 'vitest'

import {
  buildMobileNewTabAgentOptions,
  orderMobileNewTabAgents
} from './mobile-new-tab-agent-options'

const STRUCTURED_CAPABILITIES = [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]

describe('mobile new-tab agent options', () => {
  it('orders the enabled detected default first', () => {
    expect(orderMobileNewTabAgents('codex', ['gemini', 'codex', 'claude'], ['gemini'])).toEqual([
      'codex',
      'claude'
    ])
  })

  it('returns a terminal option for each enabled detected agent', () => {
    expect(
      buildMobileNewTabAgentOptions({ defaultTuiAgent: null, disabledTuiAgents: ['claude'] }, [
        'claude',
        'codex',
        'not-real'
      ])
    ).toEqual([{ agent: 'codex', label: 'Codex', mode: 'terminal' }])
  })

  it('does not show stale presets while detection is pending', () => {
    expect(buildMobileNewTabAgentOptions({ defaultTuiAgent: 'codex' }, null)).toEqual([])
  })

  it('adds a chat option for structured providers when native chat is enabled and supported', () => {
    expect(
      buildMobileNewTabAgentOptions(
        { defaultTuiAgent: null, experimentalNativeChat: true },
        ['claude', 'codex'],
        STRUCTURED_CAPABILITIES
      )
    ).toEqual([
      { agent: 'claude', label: 'Claude', mode: 'terminal' },
      { agent: 'claude', label: 'Claude Chat', mode: 'chat' },
      { agent: 'codex', label: 'Codex', mode: 'terminal' },
      { agent: 'codex', label: 'Codex Chat', mode: 'chat' }
    ])
  })

  it('offers only the terminal option when native chat is disabled', () => {
    expect(
      buildMobileNewTabAgentOptions(
        { defaultTuiAgent: null, experimentalNativeChat: false },
        ['claude'],
        STRUCTURED_CAPABILITIES
      )
    ).toEqual([{ agent: 'claude', label: 'Claude', mode: 'terminal' }])
  })

  it('offers only the terminal option when the host does not advertise structured sessions', () => {
    expect(
      buildMobileNewTabAgentOptions(
        { defaultTuiAgent: null, experimentalNativeChat: true },
        ['claude'],
        []
      )
    ).toEqual([{ agent: 'claude', label: 'Claude', mode: 'terminal' }])
  })

  it('does not add a chat option for agents without a structured session adapter', () => {
    expect(
      buildMobileNewTabAgentOptions(
        { defaultTuiAgent: null, experimentalNativeChat: true },
        ['aider'],
        STRUCTURED_CAPABILITIES
      )
    ).toEqual([{ agent: 'aider', label: 'Aider', mode: 'terminal' }])
  })
})
