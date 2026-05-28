// Pins the onboarding-cohort-classifier contract: synchronous read of
// `existedBeforeTelemetryRelease` plus the upgrade-backfill onboarding
// shape, fail-soft to `undefined` on any failure mode, at most one warn per
// session. See docs/onboarding-telemetry-extensions.md §2.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ONBOARDING_FINAL_STEP } from '../../shared/constants'
import type { GlobalSettings, OnboardingState } from '../../shared/types'
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
    // Pins current behavior: a real existing-user who completes the wizard
    // live writes the same canonical (`outcome: 'completed'`,
    // `lastCompletedStep === ONBOARDING_FINAL_STEP`) shape that the migration
    // backfill writes, so the classifier cannot distinguish them. This test
    // documents the limitation; dashboards should filter `cohort` on
    // `_started` and forward-fill across the session.
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
    // Existing user but the onboarding state isn't the migration's
    // canonical force-completed shape. Funnel-wise this user is going
    // through the wizard live, so they belong with `fresh_install`.
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
