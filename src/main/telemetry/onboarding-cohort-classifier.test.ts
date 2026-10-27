import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ONBOARDING_FINAL_STEP } from '../../shared/onboarding-defaults'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { OnboardingState } from '../../shared/onboarding-state-types'
import type { Store } from '../persistence'
import {
  _resetSessionWarnFlagForTests,
  _setStoreForTests,
  getOnboardingCohortAtEmit,
  initOnboardingCohortClassifier
} from './onboarding-cohort-classifier'

type ExistedBefore = boolean | null

function makeFakeStore(opts: {
  existedBefore: ExistedBefore
  onboarding?: Partial<OnboardingState>
  throwOnSettings?: boolean
  throwOnOnboarding?: boolean
}): Store {
  return {
    getSettings: vi.fn((): GlobalSettings => {
      if (opts.throwOnSettings) {
        throw new Error('disk fault')
      }
      return {
        telemetry: {
          installId: 'fake',
          optedIn: true,
          existedBeforeTelemetryRelease:
            opts.existedBefore === null ? undefined : opts.existedBefore
        }
      } as unknown as GlobalSettings
    }),
    getOnboarding: vi.fn((): OnboardingState => {
      if (opts.throwOnOnboarding) {
        throw new Error('disk fault')
      }
      return {
        outcome: null,
        lastCompletedStep: -1,
        closedAt: null,
        checklist: {},
        ...opts.onboarding
      } as OnboardingState
    })
  } as unknown as Store
}

describe('onboarding-cohort-classifier', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    _setStoreForTests(null)
    _resetSessionWarnFlagForTests()
  })
  afterEach(() => {
    vi.restoreAllMocks()
    _setStoreForTests(null)
  })

  it('classifies a fresh-install user as fresh_install', () => {
    initOnboardingCohortClassifier(makeFakeStore({ existedBefore: false }))
    expect(getOnboardingCohortAtEmit()).toEqual({ cohort: 'fresh_install' })
  })

  it('classifies an existing user with backfilled completion as upgrade_backfill', () => {
    initOnboardingCohortClassifier(
      makeFakeStore({
        existedBefore: true,
        onboarding: { outcome: 'completed', lastCompletedStep: ONBOARDING_FINAL_STEP }
      })
    )
    expect(getOnboardingCohortAtEmit()).toEqual({ cohort: 'upgrade_backfill' })
  })

  it('classifies a live-completed existing user as upgrade_backfill (known limitation)', () => {
    // Migration backfill and existing-user live completion share one shape; dashboards must forward-fill cohort from session _started events.
    initOnboardingCohortClassifier(
      makeFakeStore({
        existedBefore: true,
        onboarding: {
          outcome: 'completed',
          lastCompletedStep: ONBOARDING_FINAL_STEP,
          closedAt: 1234567890
        }
      })
    )
    expect(getOnboardingCohortAtEmit()).toEqual({ cohort: 'upgrade_backfill' })
  })

  it('classifies an existing user mid-wizard as fresh_install (the funnel cohort)', () => {
    // Without canonical backfill completion, existing users still going through the wizard belong to fresh_install.
    initOnboardingCohortClassifier(
      makeFakeStore({
        existedBefore: true,
        onboarding: { outcome: null, lastCompletedStep: 1 }
      })
    )
    expect(getOnboardingCohortAtEmit()).toEqual({ cohort: 'fresh_install' })
  })

  it('returns undefined when existedBeforeTelemetryRelease is unset', () => {
    initOnboardingCohortClassifier(makeFakeStore({ existedBefore: null }))
    expect(getOnboardingCohortAtEmit()).toEqual({ cohort: undefined })
  })

  it('returns undefined when the store is not initialized', () => {
    expect(getOnboardingCohortAtEmit()).toEqual({ cohort: undefined })
  })

  it('never throws and returns undefined when getSettings throws', () => {
    initOnboardingCohortClassifier(makeFakeStore({ existedBefore: false, throwOnSettings: true }))
    expect(() => getOnboardingCohortAtEmit()).not.toThrow()
    expect(getOnboardingCohortAtEmit()).toEqual({ cohort: undefined })
  })

  it('never throws and returns undefined when getOnboarding throws', () => {
    initOnboardingCohortClassifier(makeFakeStore({ existedBefore: true, throwOnOnboarding: true }))
    expect(() => getOnboardingCohortAtEmit()).not.toThrow()
    expect(getOnboardingCohortAtEmit()).toEqual({ cohort: undefined })
  })

  it('warns at most once per session even across many degraded calls', () => {
    initOnboardingCohortClassifier(makeFakeStore({ existedBefore: false, throwOnSettings: true }))
    const warnSpy = console.warn as unknown as ReturnType<typeof vi.spyOn>
    for (let i = 0; i < 50; i++) {
      getOnboardingCohortAtEmit()
    }
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })
})
