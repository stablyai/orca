import { describe, expect, it } from 'vitest'
import type { KnownRuntimeEnvironment } from '../../shared/runtime-environments'
import { runtimeEnvironmentRevisionFailure } from './runtime-environment-revision-guard'

const environment = {
  id: 'hub-a',
  runtimeId: 'runtime-b',
  createdAt: 1,
  pairingRevision: 20
} as KnownRuntimeEnvironment

describe('runtimeEnvironmentRevisionFailure', () => {
  it('fails a queued call when the saved pairing changed under the same environment id', () => {
    expect(runtimeEnvironmentRevisionFailure(environment, 10, 'worktree.rm')).toEqual({
      id: 'worktree.rm',
      ok: false,
      error: {
        code: 'runtime_environment_changed',
        message: 'Runtime environment pairing changed; refresh and try again'
      },
      _meta: { runtimeId: 'runtime-b' }
    })
  })

  it('preserves mixed-version calls that provide no revision', () => {
    expect(runtimeEnvironmentRevisionFailure(environment, undefined, 'repo.list')).toBeNull()
    expect(runtimeEnvironmentRevisionFailure(environment, 20, 'repo.list')).toBeNull()
  })
})
