import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../shared/repo-types'
import { RepoUpdatePersistenceOperations } from './repo-update-operations'

function makeRepo(overrides: Partial<Repo> & Pick<Repo, 'id'>): Repo {
  return {
    path: '/repos/example',
    displayName: 'Example',
    badgeColor: '#000000',
    addedAt: 0,
    kind: 'git',
    ...overrides
  }
}

function makeOperations(repos: Repo[]) {
  const state = { repos, projectGroups: [] }
  const scheduleSave = vi.fn()
  const operations = new RepoUpdatePersistenceOperations({
    state,
    bumpLocalWorktreeScanGeneration: vi.fn(),
    syncProjectHostSetupCompatibilityState: vi.fn(),
    scheduleSave,
    hydrateRepo: (repo) => repo
  })
  return { operations, scheduleSave, state }
}

describe('updateRepo host guard', () => {
  let errors: string[]

  beforeEach(() => {
    errors = []
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '))
    })
  })

  it('reports a host mismatch instead of returning the same silent null as a missing row', () => {
    // #22421's exact shape: the row exists under `runtime:env-1`, the caller addressed the probe host.
    const { operations, scheduleSave } = makeOperations([
      makeRepo({ id: 'repo-1', executionHostId: 'runtime:env-1' })
    ])

    const result = operations.updateRepo('repo-1', { displayName: 'Renamed' }, 'local')

    expect(result).toBeNull()
    expect(scheduleSave).not.toHaveBeenCalled()
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('repo-1')
    expect(errors[0]).toContain('requested host local')
    expect(errors[0]).toContain('runtime:env-1')
  })

  it('stays silent when the row genuinely does not exist', () => {
    const { operations } = makeOperations([
      makeRepo({ id: 'repo-1', executionHostId: 'runtime:env-1' })
    ])

    expect(operations.updateRepo('repo-missing', { displayName: 'Renamed' }, 'local')).toBeNull()
    expect(errors).toEqual([])
  })

  it('writes when the host argument matches the row stamp', () => {
    const { operations, scheduleSave, state } = makeOperations([
      makeRepo({ id: 'repo-1', executionHostId: 'runtime:env-1' })
    ])

    const result = operations.updateRepo('repo-1', { displayName: 'Renamed' }, 'runtime:env-1')

    expect(result?.displayName).toBe('Renamed')
    expect(state.repos[0].displayName).toBe('Renamed')
    expect(scheduleSave).toHaveBeenCalledTimes(1)
    expect(errors).toEqual([])
  })

  it('still refuses a cross-host write when both hosts hold a row with the same id', () => {
    const local = makeRepo({ id: 'repo-1', displayName: 'Local', executionHostId: 'local' })
    const peer = makeRepo({ id: 'repo-1', displayName: 'Peer', executionHostId: 'ssh:peer' })
    const { operations, state } = makeOperations([local, peer])

    const result = operations.updateRepo('repo-1', { displayName: 'Local edit' }, 'local')

    expect(result?.displayName).toBe('Local edit')
    // The peer's row is untouched: a client-local write must never repair another host's metadata.
    expect(state.repos[1].displayName).toBe('Peer')
  })

  it('writes without a host argument exactly as before', () => {
    const { operations, state } = makeOperations([
      makeRepo({ id: 'repo-1', executionHostId: 'runtime:env-1' })
    ])

    expect(operations.updateRepo('repo-1', { displayName: 'Renamed' })?.displayName).toBe('Renamed')
    expect(state.repos[0].displayName).toBe('Renamed')
    expect(errors).toEqual([])
  })
})
