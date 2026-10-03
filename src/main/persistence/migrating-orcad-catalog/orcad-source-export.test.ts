import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { toSshExecutionHostId } from '../../../shared/execution-host'
import type { SshTarget } from '../../../shared/ssh-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { closeTestStores, createSqliteTestStore } from '../../persistence-test-harness'
import { Store } from '../loading-store/store'
import { createOrcadMigrationManifest } from '../../ssh/orcad-migration-manifest-export'

const TARGET: SshTarget = {
  id: 'ssh-prod',
  label: 'Production',
  host: 'prod.example.com',
  port: 22,
  username: 'deploy',
  generation: 3
}
const REPO_ID = 'repo-1'
const WORKTREE_ID = `${REPO_ID}::/srv/app`

const directories: string[] = []
afterEach(async () => {
  await closeTestStores()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function dormantSession(buffer: string): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [WORKTREE_ID]: [
        {
          id: 'tab-1',
          ptyId: null,
          worktreeId: WORKTREE_ID,
          title: 'Shell',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: {
      'tab-1': {
        root: { type: 'leaf', leafId: 'leaf-1' },
        activeLeafId: 'leaf-1',
        expandedLeafId: null,
        buffersByLeafId: { 'leaf-1': buffer }
      }
    }
  }
}

function sourceStore(): Store {
  const directory = mkdtempSync(join(tmpdir(), 'orcad-source-export-'))
  directories.push(directory)
  const store = createSqliteTestStore(Store, { dataFile: join(directory, 'orca-data.json') })
  store.addSshTarget(TARGET)
  store.addRepo({
    id: REPO_ID,
    path: '/srv/app',
    displayName: 'App',
    badgeColor: '#737373',
    addedAt: 1,
    kind: 'git',
    connectionId: TARGET.id
  })
  store.setWorkspaceSession(dormantSession('dormant output\r\n'), toSshExecutionHostId(TARGET.id))
  return store
}

describe('exporting a relay-hosted SSH target from the profile store', () => {
  it('reads the target catalog and dormant scrollback without changing the source', () => {
    const store = sourceStore()
    const before = JSON.stringify({
      repos: store.getRepos(),
      session: store.getWorkspaceSession(toSshExecutionHostId(TARGET.id))
    })

    const manifest = createOrcadMigrationManifest(store, TARGET)

    expect(manifest.payload.repositories.map((repo) => repo.id)).toEqual([REPO_ID])
    const snapshots = manifest.payload.dormantState?.terminalScrollbackSnapshots ?? []
    expect(snapshots).toHaveLength(1)
    const chunk = store.readOrcadMigrationSourceSnapshotChunk(manifest, snapshots[0]!.ref, 0)
    expect(Buffer.from(chunk.bytesBase64, 'base64').toString('utf8')).toBe('dormant output\r\n')
    expect(chunk.eof).toBe(true)
    expect(
      JSON.stringify({
        repos: store.getRepos(),
        session: store.getWorkspaceSession(toSshExecutionHostId(TARGET.id))
      })
    ).toBe(before)
  })

  it('refuses a chunk once the dormant buffer changed after export', () => {
    const store = sourceStore()
    const manifest = createOrcadMigrationManifest(store, TARGET)
    const ref = manifest.payload.dormantState?.terminalScrollbackSnapshots?.[0]?.ref ?? ''
    store.setWorkspaceSession(dormantSession('rewritten output'), toSshExecutionHostId(TARGET.id))
    expect(() => store.readOrcadMigrationSourceSnapshotChunk(manifest, ref, 0)).toThrow(
      'orcad_migration_source_snapshot_changed'
    )
  })

  it('refuses a chunk for a manifest whose digest does not match its contents', () => {
    const store = sourceStore()
    const manifest = createOrcadMigrationManifest(store, TARGET)
    const ref = manifest.payload.dormantState?.terminalScrollbackSnapshots?.[0]?.ref ?? ''
    expect(() =>
      store.readOrcadMigrationSourceSnapshotChunk({ ...manifest, migrationId: 'forged' }, ref, 0)
    ).toThrow('orcad_migration_manifest_digest_mismatch')
  })

  it('names what still blocks: nothing, once the dormant state is exportable', () => {
    const store = sourceStore()
    const manifest = createOrcadMigrationManifest(store, TARGET)
    const census = store.inspectOrcadMigrationUntransferredDependencies(manifest)
    expect(census.counts['workspace-session']).toBe(0)
  })
})
