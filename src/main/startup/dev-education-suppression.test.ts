import { describe, expect, it, vi } from 'vitest'
import {
  getDefaultOnboardingState,
  getDefaultUIState,
  ONBOARDING_FINAL_STEP,
  ONBOARDING_FLOW_VERSION
} from '../../shared/constants'
import { CONTEXTUAL_TOUR_IDS } from '../../shared/contextual-tours'
import { FEATURE_INTERACTION_IDS } from '../../shared/feature-interactions'
import { FEATURE_TIP_IDS } from '../../shared/feature-tips'
import type { OnboardingState, PersistedUIState } from '../../shared/types'
import {
  DEV_SHOW_FIRST_RUN_EDUCATION_ENV,
  shouldSuppressDevEducation,
  suppressDevEducationForStore
} from './dev-education-suppression'

function createStoreState(overrides?: {
  onboarding?: Partial<OnboardingState>
  ui?: Partial<PersistedUIState>
}) {
  let onboarding: OnboardingState = {
    ...getDefaultOnboardingState(),
    ...overrides?.onboarding,
    checklist: {
      ...getDefaultOnboardingState().checklist,
      ...overrides?.onboarding?.checklist
    }
  }
  let ui: PersistedUIState = {
    ...getDefaultUIState(),
    ...overrides?.ui
  }

  return {
    get onboarding() {
      return onboarding
    },
    get ui() {
      return ui
    },
    store: {
      getOnboarding: vi.fn(() => onboarding),
      updateOnboarding: vi.fn((updates: Partial<OnboardingState>) => {
        onboarding = {
          ...onboarding,
          ...updates,
          checklist: {
            ...onboarding.checklist,
            ...updates.checklist
          }
        }
        return onboarding
      }),
      getUI: vi.fn(() => ui),
      updateUI: vi.fn((updates: Partial<PersistedUIState>) => {
        ui = { ...ui, ...updates }
      })
    }
  }
}

describe('shouldSuppressDevEducation', () => {
  it('suppresses first-run education for normal dev launches', () => {
    expect(shouldSuppressDevEducation({ isDev: true, env: {} })).toBe(true)
  })

  it('does not suppress packaged launches', () => {
    expect(shouldSuppressDevEducation({ isDev: false, env: {} })).toBe(false)
  })

  it('respects the first-run education env escape hatch', () => {
    expect(
      shouldSuppressDevEducation({
        isDev: true,
        env: { [DEV_SHOW_FIRST_RUN_EDUCATION_ENV]: '1' }
      })
    ).toBe(false)
  })

  it('does not suppress E2E-controlled profiles', () => {
    expect(
      shouldSuppressDevEducation({
        isDev: true,
        env: { ORCA_E2E_USER_DATA_DIR: '/tmp/orca-e2e' }
      })
    ).toBe(false)
  })
})

describe('suppressDevEducationForStore', () => {
  it('marks onboarding and first-run education complete', () => {
    const state = createStoreState()

    suppressDevEducationForStore(state.store, 1234)

    expect(state.onboarding).toMatchObject({
      flowVersion: ONBOARDING_FLOW_VERSION,
      closedAt: 1234,
      outcome: 'completed',
      lastCompletedStep: ONBOARDING_FINAL_STEP
    })
    expect(state.ui.featureTipsSeenIds).toEqual(FEATURE_TIP_IDS)
    expect(state.ui.contextualToursSeenIds).toEqual(CONTEXTUAL_TOUR_IDS)
    expect(state.ui.contextualToursAutoEligible).toBe(false)
    expect(Object.keys(state.ui.featureInteractions ?? {}).sort()).toEqual(
      [...FEATURE_INTERACTION_IDS].sort()
    )
  })

  it('preserves completed onboarding and existing education history', () => {
    const state = createStoreState({
      onboarding: {
        closedAt: 99,
        outcome: 'dismissed',
        lastCompletedStep: 1
      },
      ui: {
        featureTipsSeenIds: ['voice-dictation'],
        contextualToursSeenIds: ['tasks'],
        featureInteractions: {
          tasks: { firstInteractedAt: 77, interactionCount: 3 }
        }
      }
    })

    suppressDevEducationForStore(state.store, 1234)

    expect(state.store.updateOnboarding).not.toHaveBeenCalled()
    expect(state.onboarding).toMatchObject({
      closedAt: 99,
      outcome: 'dismissed',
      lastCompletedStep: 1
    })
    expect(state.ui.featureTipsSeenIds).toEqual(['voice-dictation', 'orca-cli', 'cmd-j-palette'])
    expect(state.ui.contextualToursSeenIds).toEqual([
      'tasks',
      ...CONTEXTUAL_TOUR_IDS.filter((id) => id !== 'tasks')
    ])
    expect(state.ui.featureInteractions?.tasks).toEqual({
      firstInteractedAt: 77,
      interactionCount: 3
    })
  })

  it('does not write UI when education state is already suppressed', () => {
    const featureInteractions = Object.fromEntries(
      FEATURE_INTERACTION_IDS.map((id) => [id, { firstInteractedAt: 1, interactionCount: 1 }])
    )
    const state = createStoreState({
      onboarding: {
        closedAt: 1,
        outcome: 'completed',
        lastCompletedStep: ONBOARDING_FINAL_STEP
      },
      ui: {
        featureTipsSeenIds: [...FEATURE_TIP_IDS],
        contextualToursSeenIds: [...CONTEXTUAL_TOUR_IDS],
        contextualToursAutoEligible: false,
        featureInteractions
      }
    })

    suppressDevEducationForStore(state.store, 1234)

    expect(state.store.updateOnboarding).not.toHaveBeenCalled()
    expect(state.store.updateUI).not.toHaveBeenCalled()
  })
})
