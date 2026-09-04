import { describe, expect, it } from 'vitest'

import {
  buildMobileNewTabAgentOptions,
  orderMobileNewTabAgents
} from './mobile-new-tab-agent-options'

describe('mobile new-tab agent options', () => {
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

  it('lists launch profiles under their agent only when the host supports them', () => {
    const settings = {
      defaultTuiAgent: 'codex' as const,
      agentLaunchProfiles: [{ id: 'codex-work-proxy', agent: 'codex', label: 'Work proxy' }]
    }
    expect(buildMobileNewTabAgentOptions(settings, ['codex', 'claude'])).toEqual([
      { agent: 'codex', label: 'Codex' },
      { agent: 'claude', label: 'Claude' }
    ])
    expect(
      buildMobileNewTabAgentOptions(settings, ['codex', 'claude'], {
        launchProfilesSupported: true
      })
    ).toEqual([
      { agent: 'codex', label: 'Codex' },
      {
        agent: 'codex',
        label: 'Codex · secondary home',
        launchProfileId: 'codex-secondary-home',
        hint: 'Codex launch profile'
      },
      {
        agent: 'codex',
        label: 'Work proxy',
        launchProfileId: 'codex-work-proxy',
        hint: 'Codex launch profile'
      },
      { agent: 'claude', label: 'Claude' },
      {
        agent: 'claude',
        label: 'Claude Code · secondary home',
        launchProfileId: 'claude-secondary-home',
        hint: 'Claude launch profile'
      }
    ])
  })

  it('drops malformed custom profiles instead of failing the picker', () => {
    expect(
      buildMobileNewTabAgentOptions(
        { agentLaunchProfiles: [{ id: 'Bad Id', agent: 'codex' }, 'nonsense'] },
        ['codex'],
        { launchProfilesSupported: true }
      ).map((option) => option.launchProfileId ?? null)
    ).toEqual([null, 'codex-secondary-home'])
  })
})
