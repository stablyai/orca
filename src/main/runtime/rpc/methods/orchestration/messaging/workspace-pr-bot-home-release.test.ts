import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'
import { WORKTREE_RELEASE_BOT_HOME_METHOD } from '../../bots-home-release'
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

const HOME = folderWorkspaceKey('deleted-bot-home')
const UNKNOWN = { version: 1, state: 'partial', outside: [] }
const WARNED = {
  version: 1,
  state: 'complete',
  outside: [{ forgeHost: 'github.com', owner: 'org', repo: 'q', number: 17 }]
}
const capture = {
  source: 'explicit-cli-flag',
  confidence: 'explicit'
} as const

describe("a deleted bot home's release keeps a surviving child unknown to report checks", () => {
  const harness = createOrchestrationRpcHarness()
  let store: Store
  let primary: string, child: string
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-pr-home-release-'))
    store = createStore()
    const pPath = join(testState.dir, 'p'),
      qPath = join(testState.dir, 'q')
    mkdirSync(pPath, { recursive: true })
    mkdirSync(join(qPath, 'child'), { recursive: true })
    for (const [id, path] of [
      ['p', pPath],
      ['q', qPath]
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
    store.setWorktreeMeta(hostWorktreeTarget({ id: primary, hostId: 'local' }), {
      instanceId: 'primary-instance',
      createdAt: 1
    })
    store.setWorktreeMeta(hostWorktreeTarget({ id: child, hostId: 'local' }), {
      instanceId: 'child-instance',
      createdAt: 1
    })
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
        payload: JSON.stringify({
          taskId: task.id,
          dispatchId: dispatch.id,
          outcome: 'succeeded'
        })
      },
      ctx
    )
    expect(receipt).toMatchObject({ lifecycle: { action: 'completed' } })
    return JSON.parse(db.getTask(task.id)!.result!).workspaceCheck
  }

  /** The actual home-release RPC, as a paired server receives it. */
  const release = (installationId?: string) => {
    const { runtime } = harness.setup(true, store)
    return WORKTREE_RELEASE_BOT_HOME_METHOD.handler(
      { botHomeKey: HOME, ...(installationId ? { installationId } : {}) },
      { runtime } as unknown as RpcContext
    )
  }

  const seedSameStore = () => {
    // An intact residual edge whose home folder is already gone.
    store.setFolderParentLineage(hostWorktreeTarget({ id: child, hostId: 'local' }), {
      childWorkspaceKey: worktreeWorkspaceKey(child),
      childInstanceId: 'child-instance',
      parentWorkspaceKey: HOME,
      parentInstanceId: 'deleted-bot-home',
      origin: 'cli',
      capture,
      createdAt: 1
    })
    return undefined
  }
  const seedChildStore = () => {
    // This store holds only the child; the home lives in the store `home-store` names.
    store.setCrossStoreWorkspaceLineage(
      {
        childWorkspaceKey: worktreeWorkspaceKey(child),
        childInstanceId: 'child-instance',
        parent: {
          installationId: 'home-store',
          workspaceKey: HOME,
          instanceId: 'home'
        },
        origin: 'cli',
        capture,
        createdAt: 1
      },
      'local'
    )
    return 'home-store'
  }

  it.each([
    ['same-store', seedSameStore],
    ['child-store', seedChildStore]
  ])('%s release: unknown before, after and on reopen', async (_variant, seed) => {
    const installationId = seed()
    expect(await report(store)).toEqual(UNKNOWN)
    expect(release(installationId)).toEqual({ released: 1 })
    expect(store.getWorkspaceLineage(worktreeWorkspaceKey(child))).toBeUndefined()
    expect(store.getAllCrossStoreWorkspaceLineage()).toEqual({})
    // Without a marker this is the false 'complete' warning for Q#17.
    expect(await report(store)).toEqual(UNKNOWN)
    const marker = JSON.stringify(['local', worktreeWorkspaceKey(child)])
    expect(store.getWorkspaceLineageUncertainty()).toEqual({
      [marker]: true
    })
    await store.flushPendingOrThrowAsync()
    const reopened = createStore()
    expect(reopened.getWorkspaceLineageUncertainty()).toEqual({
      [marker]: true
    })
    expect(await report(reopened)).toEqual(UNKNOWN)
  })

  it('still warns for a checkout that never had a home edge', async () => {
    expect(await report(store)).toEqual(WARNED)
    expect(release('home-store')).toEqual({ released: 0 })
    expect(store.getWorkspaceLineageUncertainty()).toEqual({})
    expect(await report(store)).toEqual(WARNED)
    await store.flushPendingOrThrowAsync()
    expect(await report(createStore())).toEqual(WARNED)
  })

  it('leaves a link to another home in place and unmarked', async () => {
    store.setCrossStoreWorkspaceLineage(
      {
        childWorkspaceKey: worktreeWorkspaceKey(child),
        childInstanceId: 'child-instance',
        parent: {
          installationId: 'home-store',
          workspaceKey: folderWorkspaceKey('other-home'),
          instanceId: 'home'
        },
        origin: 'cli',
        capture,
        createdAt: 1
      },
      'local'
    )
    expect(release('home-store')).toEqual({ released: 0 })
    expect(store.getWorkspaceLineageUncertainty()).toEqual({})
    expect(await report(store)).toEqual(UNKNOWN)
  })
})
