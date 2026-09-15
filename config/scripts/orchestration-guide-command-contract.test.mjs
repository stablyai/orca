import { describe, expect, it } from 'vitest'
import { ORCHESTRATION_COMMAND_SPECS } from '../../src/cli/specs/orchestration'
import { readOrchestrationGuideInvocations } from './orchestration-guide-invocations'

/**
 * Kept alongside tests/e2e/orchestration-guide-contract.spec.ts rather than replaced by it:
 * this runs on every PR in seconds with no build, and it is the only gate that covers the
 * documented commands the E2E spec cannot execute (legacy takeover, remote placement). The
 * E2E spec owns the other direction — that the documented sequence still WORKS. Both read
 * the guide through the same parser so the two cannot disagree about what is documented.
 */
describe('orchestration guide command contract', () => {
  it('documents only orchestration verbs and flags accepted by the CLI specs', () => {
    const specs = new Map(
      ORCHESTRATION_COMMAND_SPECS.map((spec) => [spec.path[1], new Set(spec.allowedFlags)])
    )

    for (const invocation of readOrchestrationGuideInvocations()) {
      const allowed = specs.get(invocation.verb)
      expect(allowed, `${invocation.source}: ${invocation.verb}`).toBeDefined()
      for (const flag of invocation.flags) {
        expect(allowed, `${invocation.source}: ${invocation.verb} --${flag}`).toContain(flag)
      }
    }
  })
})
