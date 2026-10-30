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
  const state = { repos, projectGroups: [], worktreeMeta: {} }
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

  it.each([undefined, ''] as const)(
    'preserves omitted removal in an old draft; explicit empty clears it: %s',
    (remove) => {
      const repo = makeRepo({
        id: 'repo-1',
        hookSettings: {
          mode: 'auto',
          commandSourcePolicy: 'run-both',
          scripts: { setup: 'old setup', archive: 'stop', remove: 'required cleanup' }
        }
      })
      const { operations, state } = makeOperations([repo])
      operations.updateRepo(
        { id: repo.id },
        {
          hookSettings: {
            mode: 'auto',
            scripts: {
              setup: 'new setup',
              archive: 'stop',
              ...(remove !== undefined ? { remove } : {})
            }
          }
        }
      )
      expect(state.repos[0].hookSettings?.scripts.remove).toBe(
        remove === undefined ? 'required cleanup' : ''
      )
      expect(state.repos[0].hookSettings?.scripts.setup).toBe('new setup')
      if (remove === undefined) {
        expect(state.repos[0].hookSettings?.commandSourcePolicy).toBe('run-both')
      }
    }
  )

  it('refuses a stale policy change that would disable an omitted required removal script', () => {
    const repo = makeRepo({
      id: 'repo-1',
      hookSettings: {
        mode: 'auto',
        commandSourcePolicy: 'local-only',
        scripts: { setup: 'old', archive: 'stop', remove: 'required cleanup' }
      }
    })
    const { operations, scheduleSave } = makeOperations([repo])
    expect(() =>
      operations.updateRepo(
        { id: repo.id },
        {
          hookSettings: {
            mode: 'auto',
            commandSourcePolicy: 'shared-only',
            scripts: { setup: 'new', archive: 'stop' }
          }
        }
      )
    ).toThrow(/removal script/i)
    expect(repo.hookSettings?.commandSourcePolicy).toBe('local-only')
    expect(repo.hookSettings?.scripts).toEqual({
      setup: 'old',
      archive: 'stop',
      remove: 'required cleanup'
    })
    expect(scheduleSave).not.toHaveBeenCalled()
    operations.updateRepo(
      { id: repo.id },
      {
        hookSettings: {
          mode: 'auto',
          commandSourcePolicy: 'shared-only',
          scripts: { setup: 'new', archive: 'stop', remove: 'required cleanup' }
        }
      }
    )
    expect(repo.hookSettings?.commandSourcePolicy).toBe('shared-only')
  })

  it('preserves all scripts when an older settings payload omits the entire scripts object', () => {
    const repo = makeRepo({
      id: 'repo-1',
      hookSettings: {
        mode: 'auto',
        scripts: { setup: 'setup', archive: 'stop', remove: 'required cleanup' }
      }
    })
    const { operations } = makeOperations([repo])
    const draft = { mode: 'auto' as const, scripts: { setup: '', archive: '' } }
    Reflect.deleteProperty(draft, 'scripts')
    operations.updateRepo({ id: repo.id }, { hookSettings: draft })
    expect(repo.hookSettings?.scripts).toEqual({
      setup: 'setup',
      archive: 'stop',
      remove: 'required cleanup'
    })
  })

  it('reports a host mismatch instead of returning the same silent null as a missing row', () => {
    // Regression #22421: caller used the probed host instead of the stored runtime row's host.
    const { operations, scheduleSave } = makeOperations([
      makeRepo({ id: 'repo-1', executionHostId: 'runtime:env-1' })
    ])

    const result = operations.updateRepo(
      { id: 'repo-1', executionHostId: 'local' },
      { displayName: 'Renamed' }
    )

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

    expect(
      operations.updateRepo(
        { id: 'repo-missing', executionHostId: 'local' },
        { displayName: 'Renamed' }
      )
    ).toBeNull()
    expect(errors).toEqual([])
  })

  it('writes when the host argument matches the row stamp', () => {
    const { operations, scheduleSave, state } = makeOperations([
      makeRepo({ id: 'repo-1', executionHostId: 'runtime:env-1' })
    ])

    const result = operations.updateRepo(
      { id: 'repo-1', executionHostId: 'runtime:env-1' },
      { displayName: 'Renamed' }
    )

    expect(result?.displayName).toBe('Renamed')
    expect(state.repos[0].displayName).toBe('Renamed')
    expect(scheduleSave).toHaveBeenCalledTimes(1)
    expect(errors).toEqual([])
  })

  it('still refuses a cross-host write when both hosts hold a row with the same id', () => {
    const local = makeRepo({ id: 'repo-1', displayName: 'Local', executionHostId: 'local' })
    const peer = makeRepo({ id: 'repo-1', displayName: 'Peer', executionHostId: 'ssh:peer' })
    const { operations, state } = makeOperations([local, peer])

    const result = operations.updateRepo(
      { id: 'repo-1', executionHostId: 'local' },
      { displayName: 'Local edit' }
    )

    expect(result?.displayName).toBe('Local edit')
    expect(state.repos[1].displayName).toBe('Peer')
  })

  it('reads a target without host fields as the local row, never the first same-id row', () => {
    const peer = makeRepo({ id: 'repo-1', displayName: 'Peer', connectionId: 'peer' })
    const local = makeRepo({ id: 'repo-1', displayName: 'Local' })
    const { operations, state } = makeOperations([peer, local])

    operations.updateRepo({ id: 'repo-1' }, { displayName: 'Renamed' })

    expect(state.repos.map((repo) => repo.displayName)).toEqual(['Peer', 'Renamed'])
  })

  it('addresses an SSH row through its connectionId alone', () => {
    const local = makeRepo({ id: 'repo-1', displayName: 'Local' })
    const peer = makeRepo({ id: 'repo-1', displayName: 'Peer', connectionId: 'peer' })
    const { operations, state } = makeOperations([local, peer])

    operations.updateRepo(peer, { displayName: 'Peer edit' })

    expect(state.repos.map((repo) => repo.displayName)).toEqual(['Local', 'Peer edit'])
    expect(errors).toEqual([])
  })
})
