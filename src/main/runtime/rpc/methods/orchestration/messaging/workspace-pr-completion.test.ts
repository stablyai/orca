import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'
import {
  createStore,
  makeRepo,
  testState,
  closeTestStores
} from '../../../../../persistence/persistence-test-harness'
import { hostWorktreeTarget } from '../../../../../../shared/worktree/host-qualified-identity'
import { worktreeWorkspaceKey } from '../../../../../../shared/workspace/identity/workspace-scope'

describe('reported PR after folder parent erasure', () => {
  const harness = createOrchestrationRpcHarness()
  afterEach(async () => {
    harness.cleanup()
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it.each(['unverifiable', 'conflicting'] as const)(
    'keeps a surviving child unknown after %s folder deletion and reload',
    async (variant) => {
      testState.dir = mkdtempSync(join(tmpdir(), 'orca-pr-lineage-'))
      const store = createStore()
      const pPath = join(testState.dir, 'p'),
        qPath = join(testState.dir, 'q'),
        childPath = join(qPath, 'child')
      mkdirSync(pPath, { recursive: true })
      mkdirSync(childPath, { recursive: true })
      store.addRepo(
        makeRepo({
          id: 'p',
          path: pPath,
          gitRemoteIdentity: {
            canonicalKey: 'github.com/org/p',
            remoteName: 'origin',
            remoteUrl: 'https://github.com/org/p'
          }
        })
      )
      store.addRepo(
        makeRepo({
          id: 'q',
          path: qPath,
          gitRemoteIdentity: {
            canonicalKey: 'github.com/org/q',
            remoteName: 'origin',
            remoteUrl: 'https://github.com/org/q'
          }
        })
      )
      const primary = `p::${pPath}`,
        child = `q::${childPath}`
      store.setWorktreeMeta(hostWorktreeTarget({ id: primary, hostId: 'local' }), {
        instanceId: 'primary-instance',
        createdAt: 1
      })
      store.setWorktreeMeta(hostWorktreeTarget({ id: child, hostId: 'local' }), {
        instanceId: 'child-instance',
        createdAt: 1
      })
      const freshReport = async (
        current: typeof store,
        settle: boolean,
        expected: 'partial' | 'complete' = 'partial',
        options: { primaryId?: string; subject?: string } = {}
      ) => {
        harness.cleanup()
        const { db, runtime, ctx } = harness.setup(true, current)
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
          worktreeId: options.primaryId ?? primary,
          terminalHandle: 'term_worker'
        })
        db.db
          .prepare('UPDATE dispatch_contexts SET assignee_handle = ? WHERE id = ?')
          .run('term_worker', dispatch.id)
        db.markWorkerDispatchReady(dispatch.id)
        const result = {
          version: 1,
          state: expected,
          outside:
            expected === 'partial'
              ? []
              : [{ forgeHost: 'github.com', owner: 'org', repo: 'q', number: 17 }]
        }
        if (!settle) {
          expect(
            runtime.checkReportedWorkspacePrs(dispatch.id, options.subject ?? 'org/q#17', '')
          ).toEqual(result)
          return
        }
        const receipt = await harness.call(
          'orchestration.send',
          {
            from: 'term_worker',
            type: 'worker_done',
            subject: options.subject ?? 'org/q#17',
            payload: JSON.stringify({
              taskId: task.id,
              dispatchId: dispatch.id,
              outcome: 'succeeded',
              workspaceCheck: {
                version: 1,
                state: 'complete',
                outside: [{ forgeHost: 'github.com', owner: 'fake', repo: 'fake', number: 999 }]
              }
            })
          },
          ctx
        )
        expect(receipt).toMatchObject({ lifecycle: { action: 'completed' } })
        expect(JSON.parse(db.getTask(task.id)!.result!).workspaceCheck).toEqual(result)
      }
      await freshReport(store, true, 'complete')
      const group = store.createProjectGroup({
        name: 'parent',
        createdFrom: 'manual',
        parentPath: testState.dir
      })
      const folder = store.createFolderWorkspace({ projectGroupId: group.id, name: 'folder' })
      const groupRow = store.getProjectGroups().find((row) => row.id === group.id)!
      const groupId = groupRow.id
      groupRow.id = 'unverifiable-group'
      try {
        await freshReport(store, true, 'partial', {
          primaryId: `folder:${folder.id}`,
          subject: 'https://github.com/org/q/pull/17'
        })
      } finally {
        groupRow.id = groupId
      }
      store.setFolderParentLineage(hostWorktreeTarget({ id: child, hostId: 'local' }), {
        childWorkspaceKey: worktreeWorkspaceKey(child),
        childInstanceId: 'child-instance',
        parentWorkspaceKey: `folder:${folder.id}`,
        parentInstanceId: 'unverifiable-instance',
        origin: 'cli',
        capture: { source: 'explicit-cli-flag', confidence: 'explicit' },
        createdAt: 1
      })
      if (variant === 'conflicting') {
        store.getAllWorktreeLineage()[child] = {
          worktreeId: child,
          worktreeInstanceId: 'child-instance',
          parentWorktreeId: 'missing::/parent',
          parentWorktreeInstanceId: 'missing-parent',
          origin: 'cli',
          capture: { source: 'explicit-cli-flag', confidence: 'explicit' },
          createdAt: 1
        }
      }
      await freshReport(store, false)
      expect(store.removeFolderWorkspace(folder.id)).toBe(true)
      expect(store.getWorkspaceLineage(worktreeWorkspaceKey(child))).toBeUndefined()
      await store.flushPendingOrThrowAsync()
      const reopened = createStore()
      await freshReport(store, true)
      await freshReport(reopened, true)
      expect(reopened.getWorkspaceLineageUncertainty()).toEqual({
        [JSON.stringify(['local', worktreeWorkspaceKey(child)])]: true
      })
      reopened.setWorktreeMeta(hostWorktreeTarget({ id: child, hostId: 'local' }), {
        instanceId: 'rotated'
      })
      await freshReport(reopened, true)
      reopened.removeWorktreeMeta(hostWorktreeTarget({ id: child, hostId: 'local' }))
      await freshReport(reopened, true)
      reopened.removeWorktreeLineage(hostWorktreeTarget({ id: child, hostId: 'local' }))
      await freshReport(reopened, true)
      reopened.setWorktreeMeta(hostWorktreeTarget({ id: child, hostId: 'local' }), {
        instanceId: 'replacement'
      })
      reopened.setWorktreeLineage(hostWorktreeTarget({ id: child, hostId: 'local' }), {
        worktreeId: child,
        worktreeInstanceId: 'replacement',
        parentWorktreeId: primary,
        parentWorktreeInstanceId: 'primary-instance',
        origin: 'cli',
        capture: { source: 'explicit-cli-flag', confidence: 'explicit' },
        createdAt: 1
      })
      await freshReport(reopened, true)
      expect(reopened.getWorkspaceLineageUncertainty()).toEqual({
        [JSON.stringify(['local', worktreeWorkspaceKey(child)])]: true
      })
    }
  )
})
