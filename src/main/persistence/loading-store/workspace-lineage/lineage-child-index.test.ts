import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import '../../../../shared/worktree/identity'
import { hostWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'
import { checkWorkspacePullRequests } from '../../../../shared/orchestration/workspace-pr-check'
import { closeTestStores, createStore, makeRepo, testState } from '../../persistence-test-harness'
import type { Store } from '../store'

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-lineage-child-index-'))
})

afterEach(async () => {
  await closeTestStores()
  rmSync(testState.dir, { recursive: true, force: true })
})

const repo = (id: string) =>
  makeRepo({
    id,
    path: `/${id}`,
    executionHostId: 'local',
    gitRemoteIdentity: {
      canonicalKey: `github.com/org/${id}`,
      remoteName: 'origin',
      remoteUrl: `https://github.com/org/${id}.git`
    }
  })

function addChild(
  store: Store,
  id: string,
  instance: string,
  parent: string,
  parentInstance: string
) {
  const target = hostWorktreeTarget({ id, hostId: 'local' })
  store.setWorktreeMeta(target, { instanceId: instance, createdAt: 1 })
  store.setWorktreeLineage(target, {
    worktreeId: id,
    worktreeInstanceId: instance,
    parentWorktreeId: parent,
    parentWorktreeInstanceId: parentInstance,
    origin: 'cli',
    capture: { source: 'explicit-cli-flag', confidence: 'explicit' },
    createdAt: 1
  })
}

// The snapshot the runtime check reads, including the Store's cached child index.
const check = (store: Store) =>
  checkWorkspacePullRequests(
    {
      repos: store.getRepos(),
      metadata: (id, host) => {
        const meta = store.getWorktreeMetaForHost(id, 'local', { migrate: false })
        return meta?.hostId === host ? meta : undefined
      },
      lineage: store.getAllWorktreeLineage(),
      workspaceLineage: store.getAllWorkspaceLineage(),
      crossStoreLineage: store.getRawCrossStoreWorkspaceLineage(),
      childIndex: store.getLineageChildIndex(),
      uncertainty: store.getWorkspaceLineageUncertainty(),
      folders: [],
      primaries: ['p::/p/work']
    },
    { subject: 'https://github.com/org/q/pull/17', body: '', spec: '', host: 'local' }
  )

// A stale index would skip the new child and turn its PR into a false outside warning.
it('drops the cached child index when a lineage write adds a child under the primary', () => {
  const store = createStore()
  store.addRepo(repo('p'))
  store.addRepo(repo('q'))
  store.setWorktreeMeta(hostWorktreeTarget({ id: 'p::/p/work', hostId: 'local' }), {
    instanceId: 'primary',
    createdAt: 1
  })
  store.setWorktreeMeta(hostWorktreeTarget({ id: 'p::/p/other', hostId: 'local' }), {
    instanceId: 'other',
    createdAt: 1
  })
  addChild(store, 'q::/q/unrelated', 'u', 'p::/p/other', 'other')
  expect(check(store)).toEqual({
    version: 1,
    state: 'complete',
    outside: [{ forgeHost: 'github.com', owner: 'org', repo: 'q', number: 17 }]
  })

  addChild(store, 'q::/q/assigned', 'a', 'p::/p/work', 'primary')
  expect(check(store)).toEqual({ version: 1, state: 'partial', outside: [] })
})
