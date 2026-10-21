import { describe, expect, it } from 'vitest'
import { buildAgentFeatureSkillInstallArgs } from '../../src/shared/agent-feature-install-commands'
import { roundTripAddArgs } from './verify-skill-update-roundtrip.mjs'

const COMMIT = 'a'.repeat(40)

describe('skill update round trip', () => {
  it('runs exactly the shared builder’s unattended add, pinned skills CLI included', () => {
    expect(roundTripAddArgs('stablyai/orca', COMMIT, 'orca-cli')).toEqual(
      buildAgentFeatureSkillInstallArgs(['orca-cli'], {
        sourceCommit: COMMIT,
        yes: true,
        agents: ['claude-code', 'universal']
      })
    )
  })
})
