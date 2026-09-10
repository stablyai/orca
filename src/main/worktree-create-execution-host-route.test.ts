import { afterEach, describe, expect, it } from 'vitest'
import { registerSshGitProvider, unregisterSshGitProvider } from './providers/ssh-git-dispatch'
import { ExecutionHostNotDispatchableError } from './providers/execution-host-provider-dispatch'
import type { Repo } from '../shared/repo-types'
import {
  requireWorktreeCreateRoute,
  resolveWorktreeCreateRoute
} from './worktree-create-execution-host-route'

const HOST_A = 'target-a'
const HOST_B = 'target-b'

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

afterEach(() => {
  unregisterSshGitProvider(HOST_A)
  unregisterSshGitProvider(HOST_B)
})

describe('resolveWorktreeCreateRoute', () => {
  it('routes a row that names its host only as executionHostId to that SSH target', () => {
    registerSshGitProvider(HOST_A, { name: 'git-a' } as never)

    expect(resolveWorktreeCreateRoute(repoRow({ executionHostId: 'ssh:target-a' }))).toMatchObject({
      kind: 'ssh',
      hostId: 'ssh:target-a',
      connectionId: HOST_A,
      repo: { connectionId: HOST_A }
    })
  })

  it('normalizes the row for a legacy connectionId-only repo without changing its answer', () => {
    expect(resolveWorktreeCreateRoute(repoRow({ connectionId: HOST_A }))).toMatchObject({
      kind: 'ssh',
      connectionId: HOST_A,
      repo: { connectionId: HOST_A }
    })
  })

  it('keeps two simultaneously registered SSH hosts on their own connections', () => {
    registerSshGitProvider(HOST_A, { name: 'git-a' } as never)
    registerSshGitProvider(HOST_B, { name: 'git-b' } as never)

    expect(resolveWorktreeCreateRoute(repoRow({ executionHostId: 'ssh:target-a' }))).toMatchObject({
      connectionId: HOST_A,
      repo: { connectionId: HOST_A }
    })
    expect(resolveWorktreeCreateRoute(repoRow({ executionHostId: 'ssh:target-b' }))).toMatchObject({
      connectionId: HOST_B,
      repo: { connectionId: HOST_B }
    })
  })

  it('lets an explicit local host win over a surviving connectionId', () => {
    // A contradictory row. `getRepoExecutionHostId` answers `local`, which is what the runtime
    // create sibling has always done; the raw read sent it remote.
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

  it('answers runtime for a runtime row whose nested target is dialable here', () => {
    registerSshGitProvider(HOST_A, { name: 'git-a' } as never)

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
    registerSshGitProvider(HOST_A, { name: 'git-a' } as never)

    expect(requireWorktreeCreateRoute(repoRow({}))).toEqual({ kind: 'local', hostId: 'local' })
    expect(requireWorktreeCreateRoute(repoRow({ executionHostId: 'ssh:target-a' }))).toMatchObject({
      kind: 'ssh',
      connectionId: HOST_A
    })
  })
})
