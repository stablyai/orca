// Pins the cohort-classifier contract: synchronous read of
// `store.getRepoCount()`, fail-soft to `undefined` on any failure mode,
// at most one warn per session. See docs/onboarding-funnel-cohort-addendum.md.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/types'
import type { Store } from '../persistence'
import {
  _resetSessionWarnFlagForTests,
  _setStoreForTests,
  getCohortAtEmit,
  initCohortClassifier
} from './cohort-classifier'

function makeFakeStore(getRepos: () => Repo[]): Store {
  // Both reads delegate to the same `getRepos` thunk so existing tests stay
  // meaningful: a throw or a list change is observed identically through
  // either accessor.
  return {
    getRepos: vi.fn(getRepos),
    getRepoCount: vi.fn(() => getRepos().length)
  } as unknown as Store
}

function makeRepos(n: number): Repo[] {
  return Array.from({ length: n }, (_, i) => ({ id: `repo-${i}` }) as unknown as Repo)
}

describe('cohort-classifier', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    _setStoreForTests(null)
    _resetSessionWarnFlagForTests()
  })
  afterEach(() => {
    vi.restoreAllMocks()
    _setStoreForTests(null)
  })

  it('returns the current repo count', () => {
    initCohortClassifier(makeFakeStore(() => makeRepos(3)))
    expect(getCohortAtEmit()).toEqual({ nth_repo_added: 3 })
  })

  // The session-zero / pre-repo cohort signal: a launch with no repos must
  // emit `0`, not `undefined`. Filtering `nth_repo_added = 0` on
  // `app_opened` is the canonical way to isolate the pre-repo cohort.
  it('returns 0 (not undefined) for an empty repo list', () => {
    initCohortClassifier(makeFakeStore(() => []))
    expect(getCohortAtEmit()).toEqual({ nth_repo_added: 0 })
  })

  it('returns undefined when the store is not initialized', () => {
    expect(getCohortAtEmit()).toEqual({ nth_repo_added: undefined })
  })

  it('returns undefined and never throws when getRepos throws', () => {
    initCohortClassifier(
      makeFakeStore(() => {
        throw new Error('disk fault')
      })
    )
    expect(() => getCohortAtEmit()).not.toThrow()
    expect(getCohortAtEmit()).toEqual({ nth_repo_added: undefined })
  })

  // Why: a degraded boot should not flood stderr; the warn-once flag is the
  // breadcrumb mechanism for "why is some chunk of last week's data
  // missing nth_repo_added?" without burning logs on every emit.
  it('warns at most once per session even across many degraded calls', () => {
    initCohortClassifier(
      makeFakeStore(() => {
        throw new Error('disk fault')
      })
    )
    const warnSpy = console.warn as unknown as ReturnType<typeof vi.spyOn>
    for (let i = 0; i < 50; i++) {
      getCohortAtEmit()
    }
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  // The session-warn flag resets on initCohortClassifier so a fresh
  // process gets a fresh breadcrumb budget.
  it('resets the warn flag when reinitialized', () => {
    initCohortClassifier(
      makeFakeStore(() => {
        throw new Error('first')
      })
    )
    getCohortAtEmit()
    initCohortClassifier(
      makeFakeStore(() => {
        throw new Error('second')
      })
    )
    getCohortAtEmit()
    const warnSpy = console.warn as unknown as ReturnType<typeof vi.spyOn>
    expect(warnSpy).toHaveBeenCalledTimes(2)
  })
})
