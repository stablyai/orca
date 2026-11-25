import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'
import type { RpcContext } from '../../../core'
import {
  createStore,
  makeRepo,
  testState,
  closeTestStores
} from '../../../../../persistence/persistence-test-harness'
import type { Store } from '../../../../../persistence/loading-store/store'
import { hostWorktreeTarget } from '../../../../../../shared/worktree/host-qualified-identity'
import {
  folderWorkspaceKey,
  worktreeWorkspaceKey
} from '../../../../../../shared/workspace/identity/workspace-scope'
import type { CrossStoreParentRef } from '../../../../../../shared/worktree/lineage-types'

const UNKNOWN = { version: 1, state: 'partial', outside: [] }
const WARNED = {
  version: 1,
  state: 'complete',
  outside: [{ forgeHost: 'github.com', owner: 'org', repo: 'q', number: 17 }]
}
const capture = { source: 'explicit-cli-flag', confidence: 'explicit' } as const
const FOLDER_IN_OTHER_STORE: CrossStoreParentRef = {
  installationId: 'other-store',
  workspaceKey: folderWorkspaceKey('remote-folder'),
  instanceId: 'remote-folder'
}
const WORKTREE_IN_OTHER_STORE: CrossStoreParentRef = {
  installationId: 'other-store',
  workspaceKey: worktreeWorkspaceKey('x::/elsewhere/x'),
  instanceId: 'remote-worktree'
}

// Q's only parent evidence is a link saved in this, the child's, store to a parent in another
// store. Ordinary detach and reparenting must not turn a fresh P report from unknown to outside.
describe('ordinary detach or reparent of a cross-store folder link keeps the child unknown', () => {
  const harness = createOrchestrationRpcHarness()
  let store: Store
  let primary: string, child: string, sibling: string, other: string
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-pr-folder-detach-'))
    store = createStore()
    const pPath = join(testState.dir, 'p'),
      qPath = join(testState.dir, 'q'),
      rPath = join(testState.dir, 'r')
    mkdirSync(pPath, { recursive: true })
    mkdirSync(join(rPath, 'sibling'), { recursive: true })
    for (const name of ['child', 'other']) {
      mkdirSync(join(qPath, name), { recursive: true })
    }
    for (const [id, path] of [
      ['p', pPath],
      ['q', qPath],
      ['r', rPath]
    ]) {
      store.addRepo(
        makeRepo({
          id,
          path,
          gitRemoteIdentity: {
            canonicalKey: `github.com/org/${id}`,
            remoteName: 'origin',
            remoteUrl: `https://github.com/org/${id}`
          }
        })
      )
    }
    primary = `p::${pPath}`
    child = `q::${join(qPath, 'child')}`
    sibling = `r::${join(rPath, 'sibling')}`
    other = `q::${join(qPath, 'other')}`
    for (const [id, instanceId] of [
      [primary, 'primary-instance'],
      [child, 'child-instance'],
      [sibling, 'sibling-instance'],
      [other, 'other-instance']
    ]) {
      store.setWorktreeMeta(hostWorktreeTarget({ id, hostId: 'local' }), {
        instanceId,
        createdAt: 1
      })
    }
  })
  afterEach(async () => {
    harness.cleanup()
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  /** A fresh, locally owned P worker reports Q#17 through an accepted worker_done. */
  const report = async (current: Store) => {
    harness.cleanup()
    const { db, ctx } = harness.setup(true, current)
    const task = db.createTask({ spec: 'Make the change' })
    const { dispatch } = db.createStartingWorkerDispatch({
      taskId: task.id,
      startOptions: {},
      creator: { kind: 'system' },
      maxDepth: 1
    })
    db.recordWorkerStage({
      dispatchId: dispatch.id,
      stage: 'input',
      worktreeId: primary,
      terminalHandle: 'term_worker'
    })
    db.db
      .prepare('UPDATE dispatch_contexts SET assignee_handle = ? WHERE id = ?')
      .run('term_worker', dispatch.id)
    db.markWorkerDispatchReady(dispatch.id)
    const receipt = await harness.call(
      'orchestration.send',
      {
        from: 'term_worker',
        type: 'worker_done',
        subject: 'Opened org/q#17',
        payload: JSON.stringify({ taskId: task.id, dispatchId: dispatch.id, outcome: 'succeeded' })
      },
      ctx
    )
    expect(receipt).toMatchObject({ lifecycle: { action: 'completed' } })
    return JSON.parse(db.getTask(task.id)!.result!).workspaceCheck
  }

  const linkToOtherStore = (id: string, instanceId: string, parent: CrossStoreParentRef) =>
    expect(
      store.setCrossStoreWorkspaceLineage(
        {
          childWorkspaceKey: worktreeWorkspaceKey(id),
          childInstanceId: instanceId,
          parent,
          origin: 'cli',
          capture,
          createdAt: 1
        },
        'local'
      )
    ).toBeDefined()

  /** The real `worktree.set --no-parent` handler; only git worktree resolution is stubbed. */
  const detach = async (id: string) => {
    harness.cleanup()
    const { runtime } = harness.setup(true, store)
    const resolved = {
      id,
      repoId: id === child ? 'q' : 'r',
      hostId: 'local',
      instanceId: `${id === child ? 'child' : 'sibling'}-instance`
    }
    vi.spyOn(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: resolveGitWorktreeSelector is the runtime's protected git resolution; stubbing it keeps the rest of the real worktree.set path.
      runtime as unknown as { resolveGitWorktreeSelector: () => Promise<unknown> },
      'resolveGitWorktreeSelector'
    ).mockResolvedValue(resolved)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler only returns the shown row; the test does not read it.
    vi.spyOn(runtime, 'showManagedWorktree').mockResolvedValue(resolved as never)
    // Loaded after the runtime graph: a top-level import of the method module stalls collection.
    const { WORKTREE_SET_METHOD } = await import('../../workspaces/worktree-set-method')
    const { WorktreeSet } =
      await import('../../../../../../shared/rpc-contract/workspaces/worktree-params')
    await WORKTREE_SET_METHOD.handler(WorktreeSet.parse({ worktree: `id:${id}`, noParent: true }), {
      runtime
    } satisfies RpcContext)
  }

  const marker = () => JSON.stringify(['local', worktreeWorkspaceKey(child)])

  const expectUnknownAfterReload = async () => {
    expect(store.getWorkspaceLineageUncertainty()).toEqual({ [marker()]: true })
    await store.flushPendingOrThrowAsync()
    const reopened = createStore()
    expect(reopened.getWorkspaceLineageUncertainty()).toEqual({ [marker()]: true })
    expect(await report(reopened)).toEqual(UNKNOWN)
  }

  it('worktree.set --no-parent: unknown before, after and on reopen', async () => {
    linkToOtherStore(child, 'child-instance', FOLDER_IN_OTHER_STORE)
    expect(await report(store)).toEqual(UNKNOWN)
    await detach(child)
    expect(store.getAllCrossStoreWorkspaceLineage()).toEqual({})
    // Without a marker this is the false 'complete' warning for Q#17.
    expect(await report(store)).toEqual(UNKNOWN)
    await expectUnknownAfterReload()
  })

  it.each([
    [
      'a same-store worktree parent',
      (s: Store, c: string, o: string) =>
        s.setWorktreeLineage(hostWorktreeTarget({ id: c, hostId: 'local' }), {
          worktreeId: c,
          worktreeInstanceId: 'child-instance',
          parentWorktreeId: o,
          parentWorktreeInstanceId: 'other-instance',
          origin: 'cli',
          capture,
          createdAt: 1
        })
    ],
    [
      'a workspace-row worktree parent',
      (s: Store, c: string, o: string) =>
        s.setWorkspaceLineage({
          childWorkspaceKey: worktreeWorkspaceKey(c),
          childInstanceId: 'child-instance',
          parentWorkspaceKey: worktreeWorkspaceKey(o),
          parentInstanceId: 'other-instance',
          origin: 'cli',
          capture,
          createdAt: 1
        })
    ]
  ])('reparenting onto %s: unknown after and on reopen', async (_name, reparent) => {
    linkToOtherStore(child, 'child-instance', FOLDER_IN_OTHER_STORE)
    expect(await report(store)).toEqual(UNKNOWN)
    expect(reparent(store, child, other)).toBeDefined()
    expect(store.getAllCrossStoreWorkspaceLineage()).toEqual({})
    // `other` is a root outside P, so without a marker Q#17 reads as outside.
    expect(await report(store)).toEqual(UNKNOWN)
    await expectUnknownAfterReload()
  })

  it('replacing the link with one to a worktree in another store keeps the marker through a later detach', async () => {
    linkToOtherStore(child, 'child-instance', FOLDER_IN_OTHER_STORE)
    linkToOtherStore(child, 'child-instance', WORKTREE_IN_OTHER_STORE)
    expect(store.getWorkspaceLineageUncertainty()).toEqual({ [marker()]: true })
    await detach(child)
    expect(await report(store)).toEqual(UNKNOWN)
    await expectUnknownAfterReload()
  })

  it('re-saving the same folder link leaves no marker', async () => {
    linkToOtherStore(child, 'child-instance', FOLDER_IN_OTHER_STORE)
    linkToOtherStore(child, 'child-instance', FOLDER_IN_OTHER_STORE)
    expect(store.getWorkspaceLineageUncertainty()).toEqual({})
    expect(await report(store)).toEqual(UNKNOWN)
  })

  it('still warns for a checkout that never had a parent edge', async () => {
    expect(await report(store)).toEqual(WARNED)
    await detach(child)
    expect(store.getWorkspaceLineageUncertainty()).toEqual({})
    expect(await report(store)).toEqual(WARNED)
    await store.flushPendingOrThrowAsync()
    expect(await report(createStore())).toEqual(WARNED)
  })

  it('detaching a link to a worktree in another store leaves no folder marker', async () => {
    linkToOtherStore(child, 'child-instance', WORKTREE_IN_OTHER_STORE)
    expect(await report(store)).toEqual(UNKNOWN)
    await detach(child)
    expect(store.getWorkspaceLineageUncertainty()).toEqual({})
    expect(await report(store)).toEqual(WARNED)
  })

  it("detaching another project's folder link marks only that checkout", async () => {
    linkToOtherStore(sibling, 'sibling-instance', FOLDER_IN_OTHER_STORE)
    expect(await report(store)).toEqual(WARNED)
    await detach(sibling)
    expect(store.getWorkspaceLineageUncertainty()).toEqual({
      [JSON.stringify(['local', worktreeWorkspaceKey(sibling)])]: true
    })
    expect(await report(store)).toEqual(WARNED)
  })
})
