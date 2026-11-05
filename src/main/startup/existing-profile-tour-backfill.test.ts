import { describe, expect, it } from 'vitest'
import type { Store } from '../persistence/loading-store/store'
import { backfillAgentSessionsTourForExistingProfiles } from './existing-profile-tour-backfill'

// 2026-11-04T23:53:56Z, the v1.4.249 publish time.
const CUTOFF = 1793836436000

function createStore(closedAt: number | null, contextualToursSeenIds?: string[]) {
  let ui = { contextualToursSeenIds }
  const store = {
    getOnboarding: () => ({ closedAt }),
    getUI: () => ui,
    updateUI: (updates: typeof ui) => {
      ui = { ...ui, ...updates }
    }
  } as unknown as Pick<Store, 'getOnboarding' | 'getUI' | 'updateUI'>
  return { store, seenIds: () => ui.contextualToursSeenIds }
}

describe('backfillAgentSessionsTourForExistingProfiles', () => {
  it('keeps the tour for profiles still in onboarding or onboarded at or after the release', () => {
    for (const closedAt of [null, CUTOFF, CUTOFF + 1]) {
      const { store, seenIds } = createStore(closedAt, [])
      backfillAgentSessionsTourForExistingProfiles(store)
      expect(seenIds()).toEqual([])
    }
  })

  it('marks the tour seen for profiles onboarded before the release, keeping other seen tours', () => {
    const { store, seenIds } = createStore(CUTOFF - 1, ['browser'])
    backfillAgentSessionsTourForExistingProfiles(store)
    backfillAgentSessionsTourForExistingProfiles(store)
    expect(seenIds()).toEqual(['browser', 'workspace-agent-sessions'])
  })
})
