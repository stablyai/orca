import { describe, expect, it } from 'vitest'
import { getCommitMessageAgentSpec } from '../../../shared/source-control/ai/generation/commit-message-agent-spec'
import { planCommitMessageGeneration } from '../../../shared/source-control/ai/generation/commit-message-plan'
import { planModelDiscovery } from './commit-message-model-discovery-policy'

const antigravity = getCommitMessageAgentSpec('antigravity')
if (!antigravity) {
  throw new Error('antigravity commit-message spec is missing')
}

describe('commit-message agent auto-update suppression', () => {
  it('adds the updater suppression env to model discovery and generation', () => {
    const suppressed = { ok: true, plan: { env: { AGY_CLI_DISABLE_AUTO_UPDATE: 'true' } } }
    expect(planModelDiscovery(antigravity)).toMatchObject(suppressed)
    expect(
      planCommitMessageGeneration(
        { agentId: 'antigravity', model: antigravity.defaultModelId },
        'Write a commit message'
      )
    ).toMatchObject(suppressed)
  })

  it('lets a command-override assignment win over the suppression env', () => {
    expect(planModelDiscovery(antigravity, 'AGY_CLI_DISABLE_AUTO_UPDATE=false agy')).toMatchObject({
      ok: true,
      plan: { env: { AGY_CLI_DISABLE_AUTO_UPDATE: 'false' } }
    })
  })
})
