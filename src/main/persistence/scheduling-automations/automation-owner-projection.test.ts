import { describe, expect, it } from 'vitest'
import { buildProfileStateCutoverFixture } from '../profile-state-cutover-fixture'
import {
  automationOwnerPrecondition,
  automationChangeSelector,
  automationCapturedHostIssue,
  assertAutomationOwnerFence
} from './automation-owner-projection'

describe('automation metadata projection cost', () => {
  it.each([1_000, 10_000])(
    'does not read %i retained rows for owner, routing or precondition calls',
    (size) => {
      const state = buildProfileStateCutoverFixture()
      state.automationFailureSeenVersion = 1
      const automation = { ...state.automations[0], projectId: state.repos[0].id }
      state.automations = [automation]
      const template = state.automationRuns[0]
      let reads = 0
      state.automationRuns = Array.from({ length: size }, (_, index) => ({
        ...template,
        id: `run-${index}`,
        get status() {
          reads++
          return 'dispatch_failed' as const
        },
        get automationId() {
          reads++
          return automation.id
        }
      }))
      const owner = automationOwnerPrecondition(state, 'desktop', automation.id)
      expect(owner).not.toBeNull()
      expect(automationChangeSelector(state, 'desktop', automation.id)).not.toBeNull()
      expect(automationCapturedHostIssue(state, 'desktop', automation)).toBeNull()
      expect(
        assertAutomationOwnerFence({
          state,
          storageAuthority: 'desktop',
          id: automation.id,
          ...(owner ? { expectedOwner: owner } : {}),
          operation: 'execute'
        })
      ).toBe(automation)
      expect(reads).toBe(0)
    }
  )
})
