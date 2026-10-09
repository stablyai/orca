import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'
import { areWorktreePathsEqual } from '../ipc/worktree-path-comparison'
import { closeTestStores, createSqliteTestStore } from '../persistence-test-harness'
import { Store } from '../persistence/loading-store/store'
import { OrcaRuntimeService } from './orca-runtime'

const directories: string[] = []
const stores: Store[] = []
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.flushPendingOrThrowAsync()))
  await closeTestStores()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

async function fixture(kind: 'git' | 'folder') {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'orca-runtime-metadata-discovery-')))
  directories.push(directory)
  const path = join(directory, 'project')
  mkdirSync(path)
  if (kind === 'git') {
    for (const args of [
      ['init', '-q'],
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.test',
        'commit',
        '--allow-empty',
        '-qm',
        'initial'
      ]
    ]) {
      const result = await runProcess({ program: 'git', args, cwd: path, timeoutMs: 10_000 })
      expect(result.code, result.stderr).toBe(0)
    }
  }
  const dataFile = join(directory, 'orca-data.json')
  const store = createSqliteTestStore(Store, { dataFile })
  stores.push(store)
  const repo = {
    id: 'repo-discovery',
    path,
    kind,
    displayName: 'Project',
    badgeColor: 'blue',
    addedAt: 1,
    executionHostId: 'local' as const
  }
  store.addRepo(repo)
  return { store, runtime: new OrcaRuntimeService(store), repo, dataFile }
}

describe('runtime creation and discovery remain metadata authorities', () => {
  it.each(['git', 'folder'] as const)(
    'registers a first %s occupant, admits its update and reloads it from SQLite',
    async (kind) => {
      const { store, runtime, repo, dataFile } = await fixture(kind)
      expect(store.getAllWorktreeMeta()).toEqual({})
      const worktree =
        kind === 'folder'
          ? (
              await runtime.createManagedWorktree({
                repoSelector: `id:${repo.id}`,
                name: 'First workspace'
              })
            ).worktree
          : (await runtime.listManagedWorktrees(`id:${repo.id}`)).worktrees.find((row) =>
              areWorktreePathsEqual(row.path, repo.path)
            )
      if (!worktree) {
        throw new Error('fixture_missing_worktree')
      }
      const resolved = await runtime.showManagedWorktree(`id:${worktree.id}`)
      if (!resolved.identity || !resolved.instanceId) {
        throw new Error('fixture_missing_discovered_identity')
      }
      expect(
        store.isCurrentWorktreeMetadata(worktree.id, {
          executionHostId: 'local',
          instanceId: resolved.instanceId
        })
      ).toBe(true)
      const result = await runtime.updateManagedWorktreeMeta(`identity:${resolved.identity.key}`, {
        comment: 'first update'
      })
      expect(result.comment).toBe('first update')
      expect(result.identity).toEqual(resolved.identity)
      await store.flushPendingOrThrowAsync()
      const reopened = createSqliteTestStore(Store, { dataFile })
      stores.push(reopened)
      expect(reopened.getWorktreeMetaForHost(worktree.id, 'local')).toEqual(
        store.getWorktreeMetaForHost(worktree.id, 'local')
      )
    }
  )
})
