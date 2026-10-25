import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import type { Store } from '../persistence'
import {
  _resetSessionWarnFlagForTests,
  _setStoreForTests,
  getCohortAtEmit,
  initCohortClassifier
} from './cohort-classifier'

function makeFakeStore(getRepos: () => Repo[]): Store {
  // Both fake accessors share one repo source so changes/failures stay consistent.
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

  // Zero is the canonical pre-repo cohort, not absent classifier data.
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

  // Warn once on degraded reads so missing cohort data is diagnosable without flooding logs.
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
