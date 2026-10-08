import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SshRemotePtyLease, SshTarget } from '../../shared/ssh-types'
import { closeTestStores, createSqliteTestStore } from '../persistence-test-harness'
import { Store } from '../persistence/loading-store/store'
import {
  preflightOrcadMigrationExport,
  type OrcadMigrationPreflightStore
} from './ssh-target-orcad-preflight'

const TARGET: SshTarget = {
  id: 'ssh-prod',
  label: 'Production',
  host: 'prod.example.com',
  port: 22,
  username: 'deploy',
  generation: 2
}

const directories: string[] = []
afterEach(async () => {
  await closeTestStores()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function preflightStore(
  configure: (store: Store) => void,
  overrides: Partial<OrcadMigrationPreflightStore> = {}
): OrcadMigrationPreflightStore {
  const directory = mkdtempSync(join(tmpdir(), 'orcad-export-preflight-'))
  directories.push(directory)
  const store = createSqliteTestStore(Store, { dataFile: join(directory, 'orca-data.json') })
  configure(store)
  return {
    getSshTarget: (id) => store.getSshTarget(id),
    getSshRemotePtyLeases: (id) => store.getSshRemotePtyLeases(id),
    getRepos: () => store.getRepos(),
    getFolderWorkspaces: () => store.getFolderWorkspaces(),
    getProjectGroups: () => store.getProjectGroups(),
    collectOrcadMigrationSourceDormantState: (...args) =>
      store.collectOrcadMigrationSourceDormantState(...args),
    inspectOrcadMigrationUntransferredDependencies: (manifest) =>
      store.inspectOrcadMigrationUntransferredDependencies(manifest),
    ...overrides
  }
}

function withRepo(store: Store): void {
  store.addSshTarget(TARGET)
  store.addRepo({
    id: 'repo-1',
    path: '/srv/app',
    displayName: 'App',
    badgeColor: '#737373',
    addedAt: 1,
    kind: 'git',
    connectionId: TARGET.id
  })
}

describe('migration export preflight', () => {
  it('drains the catalog the target owns instead of blocking on it', () => {
    const result = preflightOrcadMigrationExport(preflightStore(withRepo), TARGET.id)
    expect(result.claimable).toBe(true)
    expect(result.blockers.map((blocker) => blocker.code)).toEqual([
      'orcad_migration_direct_ssh_repositories'
    ])
  })

  it('previews a connected but unused host as movable with no blockers', () => {
    const store = preflightStore((store) => {
      store.addSshTarget(TARGET)
      // What the renderer writes on connect: the reconnect hint names the now-connected target.
      store.patchWorkspaceSession({ activeConnectionIdsAtShutdown: [TARGET.id] })
    })
    expect(preflightOrcadMigrationExport(store, TARGET.id)).toMatchObject({
      claimable: true,
      blockers: []
    })
  })

  it('blocks on a live relay terminal, which cannot move', () => {
    const lease: SshRemotePtyLease = {
      targetId: TARGET.id,
      ptyId: 'pty-1',
      state: 'attached',
      createdAt: 1,
      updatedAt: 1
    }
    const result = preflightOrcadMigrationExport(
      preflightStore(withRepo, { getSshRemotePtyLeases: () => [lease] }),
      TARGET.id
    )
    expect(result.claimable).toBe(false)
    expect(result.blockers.map((blocker) => blocker.code)).toContain(
      'orcad_migration_direct_ssh_terminal_leases'
    )
  })

  it('blocks on dependent state the manifest cannot carry', () => {
    const result = preflightOrcadMigrationExport(
      preflightStore(withRepo, {
        inspectOrcadMigrationUntransferredDependencies: () => ({
          totalCount: 2,
          counts: {
            automation: 2,
            'automation-run': 0,
            'mobile-tab-selection': 0,
            'retired-worktree-name': 0,
            'saved-port-forward': 0,
            'sparse-preset': 0,
            'terminal-lease': 0,
            'terminal-recovery': 0,
            'ui-routing': 0,
            'workspace-lineage': 0,
            'workspace-session': 0,
            'worktree-lineage': 0,
            'worktree-metadata': 0
          }
        })
      }),
      TARGET.id
    )
    expect(result.claimable).toBe(false)
    expect(result.blockers).toContainEqual({
      code: 'orcad_migration_dependent_state',
      category: 'client-owned-state',
      dependencies: [{ kind: 'automation', count: 2 }]
    })
  })

  it('treats a census the store could not take as unverifiable, never empty', () => {
    const result = preflightOrcadMigrationExport(
      preflightStore(withRepo, {
        inspectOrcadMigrationUntransferredDependencies: () => {
          throw new Error('state unreadable')
        }
      }),
      TARGET.id
    )
    expect(result.claimable).toBe(false)
    expect(result.blockers.map((blocker) => blocker.code)).toContain(
      'orcad_migration_dependency_unverifiable'
    )
  })

  it('refuses a target another runtime owns, and passes the owner only with its journal', () => {
    const owned = preflightStore((store) =>
      store.addSshTarget({ ...TARGET, orcadFence: { environmentId: 'env-1' } })
    )
    expect(preflightOrcadMigrationExport(owned, TARGET.id).claimable).toBe(false)
    expect(
      preflightOrcadMigrationExport(owned, TARGET.id, { environmentId: 'env-1', recorded: true })
        .claimable
    ).toBe(true)
    expect(
      preflightOrcadMigrationExport(owned, TARGET.id, { environmentId: 'env-1', recorded: false })
    ).toMatchObject({
      claimable: false,
      blockers: [{ code: 'orcad_migration_owner_unrecorded' }]
    })
  })

  it('reports an unknown target', () => {
    expect(
      preflightOrcadMigrationExport(
        preflightStore(() => {}),
        'missing'
      )
    ).toMatchObject({
      claimable: false,
      blockers: [{ code: 'orcad_migration_target_not_found' }]
    })
  })
})
