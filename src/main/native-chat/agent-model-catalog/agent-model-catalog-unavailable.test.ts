import { describe, expect, it } from 'vitest'
import { agentModelCatalogFingerprint } from './agent-model-catalog-fingerprint'
import { agentsWithChangedLaunchSettings } from './agent-model-catalog-account-expiry'

const HOME = '/homes/selected'

agentModelCatalogFingerprint({
  agent: 'grok',
  accountHomeVariable: 'GROK_HOME',
  accountHomePath: HOME,
  wslDistro: null
})

describe("an agent's command or environment change", () => {
  it('touches only the agents whose command or env changed', () => {
    expect(
      agentsWithChangedLaunchSettings(
        {
          agentCmdOverrides: { grok: 'grok', claude: 'claude' },
          agentDefaultEnv: { claude: { A: '1', B: '2' } }
        },
        {
          agentCmdOverrides: { grok: 'grok', claude: 'claude' },
          agentDefaultEnv: { claude: { B: '2', A: '1' }, pi: { KEY: 'x' } }
        }
      )
    ).toEqual(['pi'])
    expect(agentsWithChangedLaunchSettings({ agentCmdOverrides: { grok: 'grok' } }, {})).toEqual([
      'grok'
    ])
  })
})
