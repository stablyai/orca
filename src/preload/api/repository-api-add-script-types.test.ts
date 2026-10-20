import { describe, expect, expectTypeOf, it } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import type {
  RepoWithRepositoryAddScriptPreview,
  RepositoryAddScriptDecision,
  RepositoryAddScriptDecisionResult,
  RepositoryAddScriptIdentity,
  RepositoryAddScriptOutcome
} from '../../shared/repository-add-script-types'
import type { RepositoryApi } from './repository-api'

describe('repository API add-script types', () => {
  it('keeps a call without the opt-in a bare Repo and wraps only the opted-in call', () => {
    // Compile-time only: the function is never called.
    const checkOverloads = (clone: RepositoryApi['clone']): void => {
      expectTypeOf(clone({ url: 'u', destination: 'd' })).toEqualTypeOf<Promise<Repo>>()
      expectTypeOf(
        clone({ url: 'u', destination: 'd', repositoryAddScriptPreview: { hostId: 'local' } })
      ).toEqualTypeOf<Promise<RepoWithRepositoryAddScriptPreview>>()
    }
    expect(checkOverloads).toBeTypeOf('function')
  })

  it('offers decide and outcome that take only the typed identity', () => {
    expectTypeOf<RepositoryApi['decideAddScript']>().toEqualTypeOf<
      (args: RepositoryAddScriptDecision) => Promise<RepositoryAddScriptDecisionResult>
    >()
    expectTypeOf<RepositoryApi['getAddScriptOutcome']>().toEqualTypeOf<
      (args: RepositoryAddScriptIdentity) => Promise<RepositoryAddScriptOutcome | null>
    >()
  })
})
