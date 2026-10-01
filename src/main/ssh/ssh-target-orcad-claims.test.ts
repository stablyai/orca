import { describe, expect, it, vi } from 'vitest'
import {
  createManagedOrcadSshOwner,
  getManagedOrcadOwnerEnvironmentId
} from '../../shared/managed-orcad-ssh-owner'
import type { SshRemotePtyLease, SshTarget } from '../../shared/ssh-types'
import { SshTargetOrcadClaims } from './ssh-target-orcad-claims'
import { emptyDependentStateStore } from './ssh-target-orcad-dependents-fixture'

type SetupOptions = {
  target?: Partial<SshTarget>
  repos?: { id: string; path: string; displayName: string }[]
  folders?: { id: string; name: string; folderPath: string }[]
  leases?: Partial<SshRemotePtyLease>[]
}

function setup(options: SetupOptions = {}) {
  let target: SshTarget = {
    id: 'ssh-1',
    label: 'Builder',
    host: 'builder',
    port: 22,
    username: 'dev',
    ...options.target
  }
  const flush = vi.fn(async () => {})
  const rows = { connectionId: 'ssh-1' }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: preflight reads only id, name, folderPath and connectionId.
  const folders = (options.folders ?? []).map((f) => ({ ...f, ...rows })) as never
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: preflight reads only id, path, displayName, kind and connectionId.
  const repos = (options.repos ?? []).map((r) => ({ ...r, ...rows })) as never
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: preflight reads only ptyId and state.
  const leases = (options.leases ?? []) as never
  const claims = new SshTargetOrcadClaims({
    ...emptyDependentStateStore(),
    allocateSshTargetGeneration: () => 4,
    flushPendingOrThrowAsync: flush,
    getFolderWorkspaces: () => folders,
    getRepos: () => repos,
    getSshRemotePtyLeases: () => leases,
    getSshTarget: (id) => (id === target.id ? target : undefined),
    getSshTargets: () => [target],
    updateSshTarget: (_id, updates) => (target = { ...target, ...updates })
  })
  return { claims, flush, current: () => target }
}

describe('managed orcad SSH target claims', () => {
  it('claims an empty target with a generation and a resumable provisioning intent', () => {
    const { claims, current } = setup()
    const claimed = claims.claim('ssh-1', 'environment-1', 'Managed')
    expect(getManagedOrcadOwnerEnvironmentId(claimed.owner)).toBe('environment-1')
    expect(claimed.generation).toBe(4)
    expect(current().orcadProvisioning).toEqual({ requestId: 'environment-1', name: 'Managed' })
  })

  it('is idempotent for its own environment and keeps an earlier provisioning request', () => {
    const { claims } = setup({
      target: {
        generation: 2,
        owner: createManagedOrcadSshOwner('environment-1'),
        orcadProvisioning: { requestId: 'request-1', name: 'From dialog' }
      }
    })
    const claimed = claims.claim('ssh-1', 'environment-1', 'Other name')
    expect(claimed.generation).toBe(2)
    expect(claimed.orcadProvisioning).toEqual({ requestId: 'request-1', name: 'From dialog' })
  })

  it('claims for SSH access without recording a provisioning intent', () => {
    const { claims } = setup({ target: { generation: 1 } })
    expect(claims.claim('ssh-1', 'environment-1').orcadProvisioning).toBeUndefined()
  })

  it.each<[string, SetupOptions, string]>([
    ['another owner', { target: { owner: createManagedOrcadSshOwner('other') } }, 'already owned'],
    [
      'direct SSH repositories',
      { repos: [{ id: 'repo-1', path: '/srv/app', displayName: 'app' }] },
      'repositories or folder workspaces'
    ],
    [
      'folder workspaces',
      { folders: [{ id: 'folder-1', name: 'scratch', folderPath: '/srv/scratch' }] },
      'repositories or folder workspaces'
    ],
    [
      'a saved terminal lease',
      { leases: [{ ptyId: 'pty-1', state: 'detached' }] },
      'terminal-lease ×1 (pty-1 (detached))'
    ],
    [
      'saved port forwards',
      {
        target: {
          portForwards: [{ localPort: 1, remoteHost: 'localhost', remotePort: 2 }]
        }
      },
      'port forwards'
    ]
  ])('refuses a target with %s and leaves it unclaimed', (_label, options, message) => {
    const { claims, current } = setup(options)
    expect(claims.preflight('ssh-1').claimable).toBe(false)
    expect(() => claims.claim('ssh-1', 'environment-1', 'Managed')).toThrow(message)
    expect(current().orcadProvisioning).toBeUndefined()
  })

  it('counts terminated and expired leases too, since they still name this host', () => {
    const { claims } = setup({
      leases: [
        { ptyId: 'a', state: 'terminated' },
        { ptyId: 'b', state: 'expired' }
      ]
    })
    expect(claims.preflight('ssh-1').blockers).toEqual([
      {
        code: 'orcad_migration_dependent_state',
        category: 'client-owned-state',
        dependencies: [
          { kind: 'terminal-lease', count: 2, names: ['a (terminated)', 'b (expired)'] }
        ]
      }
    ])
  })

  it('reports an unknown target as a registration blocker', () => {
    const { claims } = setup()
    expect(claims.preflight('missing').blockers).toEqual([
      { code: 'orcad_migration_target_not_found', category: 'registration' }
    ])
  })

  it('releases only its own claim and clears the provisioning intent', () => {
    const { claims, current } = setup()
    claims.claim('ssh-1', 'environment-1', 'Managed')
    expect(claims.release('ssh-1', 'environment-2')).toBeNull()
    expect(claims.release('ssh-1', 'environment-1')).toMatchObject({
      owner: undefined,
      orcadProvisioning: undefined
    })
    expect(current().owner).toBeUndefined()
  })

  it('flushes without draining to a stable generation', async () => {
    const { claims, flush } = setup()
    await claims.flush()
    expect(flush).toHaveBeenCalledWith({ signal: undefined, drainToStableGeneration: false })
  })
})
