import { describe, expect, it } from 'vitest'
import { ExecutionHostNotDispatchableError } from './providers/execution-host-provider-dispatch'
import type { Repo } from '../shared/repo-types'
import {
  requireWorktreeCreateRoute,
  resolveWorktreeCreateRoute
} from './worktree-create-execution-host-route'

const HOST_A = 'target-a'

function repoRow(fields: Partial<Repo>): Repo {
  return {
    id: 'repo-1',
    path: '/remote/repo',
    displayName: 'repo',
    badgeColor: '#000',
    addedAt: 0,
    ...fields
  } as Repo
}

describe('resolveWorktreeCreateRoute', () => {
  it('routes a row that names its host only as executionHostId to that SSH target', () => {
    expect(resolveWorktreeCreateRoute(repoRow({ executionHostId: 'ssh:target-a' }))).toEqual({
      kind: 'ssh',
      hostId: 'ssh:target-a',
      connectionId: HOST_A
    })
  })

  it('routes a legacy connectionId-only repo to the same SSH target', () => {
    expect(resolveWorktreeCreateRoute(repoRow({ connectionId: HOST_A }))).toEqual({
      kind: 'ssh',
      hostId: 'ssh:target-a',
      connectionId: HOST_A
    })
  })

  it('lets an explicit local host win over a surviving connectionId', () => {
    expect(
      resolveWorktreeCreateRoute(repoRow({ executionHostId: 'local', connectionId: HOST_A }))
    ).toEqual({ kind: 'local', hostId: 'local' })
  })

  it('answers runtime for a runtime row with no nested SSH target', () => {
    expect(resolveWorktreeCreateRoute(repoRow({ executionHostId: 'runtime:env-1' }))).toEqual({
      kind: 'runtime',
      hostId: 'runtime:env-1',
      environmentId: 'env-1'
    })
  })

  it('answers runtime for a runtime row that also names a nested target', () => {
    expect(
      resolveWorktreeCreateRoute(
        repoRow({ executionHostId: 'runtime:env-1', connectionId: HOST_A })
      )
    ).toMatchObject({ kind: 'runtime', environmentId: 'env-1' })
  })
})

describe('requireWorktreeCreateRoute', () => {
  it('refuses a runtime host rather than creating through this client', () => {
    expect(() => requireWorktreeCreateRoute(repoRow({ executionHostId: 'runtime:env-1' }))).toThrow(
      ExecutionHostNotDispatchableError
    )
  })

  it('passes local and SSH hosts through unchanged', () => {
    expect(requireWorktreeCreateRoute(repoRow({}))).toEqual({ kind: 'local', hostId: 'local' })
    expect(requireWorktreeCreateRoute(repoRow({ executionHostId: 'ssh:target-a' }))).toMatchObject({
      kind: 'ssh',
      connectionId: HOST_A
    })
  })
})
