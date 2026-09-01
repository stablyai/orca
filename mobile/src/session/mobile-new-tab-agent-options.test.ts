import { describe, expect, it } from 'vitest'
import type { AgentCatalogSnapshot } from '../../../src/shared/agent-catalog-snapshot'

import {
  buildMobileNewTabAgentOptions,
  orderMobileNewTabAgents
} from './mobile-new-tab-agent-options'

describe('mobile new-tab agent options', () => {
  const catalog: AgentCatalogSnapshot = {
    version: 1,
    revision: 1,
    defaultAgent: 'auto',
    disabledAgents: [],
    customAgents: [
      {
        id: 'custom-agent:claude:one',
        baseAgent: 'claude',
        label: 'My Claude',
        args: '',
        syncEnv: false,
        status: 'ready',
        envState: 'none',
        availabilityCheck: 'baseline-detection'
      }
    ],
    deletedCustomAgents: []
  }

  it('orders the enabled detected default first', () => {
    expect(orderMobileNewTabAgents('codex', ['gemini', 'codex', 'claude'], ['gemini'])).toEqual([
      'codex',
      'claude'
    ])
  })

  it('returns labeled options for enabled detected agents only', () => {
    expect(
      buildMobileNewTabAgentOptions({ defaultTuiAgent: null, disabledTuiAgents: ['claude'] }, [
        'claude',
        'codex',
        'not-real'
      ])
    ).toEqual([{ agent: 'codex', label: 'Codex' }])
  })

  it('does not show stale presets while detection is pending', () => {
    expect(buildMobileNewTabAgentOptions({ defaultTuiAgent: 'codex' }, null)).toEqual([])
  })

  it('includes catalog-backed custom agents when their base is detected', () => {
    expect(buildMobileNewTabAgentOptions({}, ['claude', 'codex'], catalog)).toEqual([
      { agent: 'claude', label: 'Claude' },
      { agent: 'custom-agent:claude:one', label: 'My Claude' },
      { agent: 'codex', label: 'Codex' }
    ])
  })

  it('orders an available custom default first', () => {
    expect(
      buildMobileNewTabAgentOptions(
        { defaultTuiAgent: 'custom-agent:claude:one' },
        ['claude', 'codex'],
        catalog
      )
    ).toEqual([
      { agent: 'custom-agent:claude:one', label: 'My Claude' },
      { agent: 'claude', label: 'Claude' },
      { agent: 'codex', label: 'Codex' }
    ])
  })

  it('hides a custom agent when its base is not detected', () => {
    expect(buildMobileNewTabAgentOptions({}, ['codex'], catalog)).toEqual([
      { agent: 'codex', label: 'Codex' }
    ])
  })
})
