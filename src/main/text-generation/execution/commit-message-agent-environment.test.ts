import { describe, expect, it } from 'vitest'
import { withModelDiscoveryLaunchEnv } from '../../runtime/integrations/git/model-discovery-launch-env'
import { prepareLocalCommitMessageAgentEnv } from './commit-message-agent-environment'

describe('prepareLocalCommitMessageAgentEnv', () => {
  it('lets the Codex account home beat the launch env and the login shell', async () => {
    const prepared = await prepareLocalCommitMessageAgentEnv('codex', {
      prepareForCodexLaunch: () => '/account',
      resolveBaseEnvironment: () => Promise.resolve({ CODEX_HOME: '/shell', PATH: '/bin' })
    })
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) {
      return
    }
    const merged = withModelDiscoveryLaunchEnv(
      { CODEX_HOME: '/launch' },
      prepared.env,
      prepared.accountPatch
    )
    expect(merged?.CODEX_HOME).toBe('/account')
    expect(prepared.accountPatch).toEqual({ CODEX_HOME: '/account' })
  })
})
