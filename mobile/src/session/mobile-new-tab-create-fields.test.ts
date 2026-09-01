import { describe, expect, it } from 'vitest'
import type { TuiAgent } from '../../../src/shared/tui-agent'
import { buildMobileNewTabCreateFields } from './mobile-new-tab-create-fields'

const customAgent = 'custom-agent:claude:0f8b7c6a-1d2e-4a3b-9c4d-5e6f7a8b9c0d' as TuiAgent

describe('buildMobileNewTabCreateFields', () => {
  it('routes a custom picker row through the custom-admitting agentLaunch field', () => {
    expect(buildMobileNewTabCreateFields({ agent: customAgent })).toEqual({
      agentLaunch: {
        selection: { kind: 'agent', agent: customAgent },
        allowEmptyPromptLaunch: true
      }
    })
  })

  it('puts a custom agent prompt inside the atomic launch request', () => {
    expect(buildMobileNewTabCreateFields({ agent: customAgent, agentPrompt: 'Review it' })).toEqual(
      {
        agentLaunch: {
          selection: { kind: 'agent', agent: customAgent },
          prompt: 'Review it'
        }
      }
    )
  })

  it('preserves the legacy fields for built-in agents', () => {
    expect(buildMobileNewTabCreateFields({ agent: 'codex', agentPrompt: 'Review it' })).toEqual({
      agent: 'codex',
      agentPrompt: 'Review it'
    })
  })
})
