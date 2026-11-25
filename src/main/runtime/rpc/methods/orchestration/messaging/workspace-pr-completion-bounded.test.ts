import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
import * as childIndexModule from '../../../../../../shared/orchestration/lineage-child-index'
import { hostWorktreeTarget } from '../../../../../../shared/worktree/host-qualified-identity'
import { LINEAGE_SCAN_ROW_LIMIT } from '../../../../../../shared/worktree/lineage/lineage-uncertainty'
import type { Store } from '../../../../../persistence/loading-store/store'

const Q17 = { forgeHost: 'github.com', owner: 'org', repo: 'q', number: 17 }
// Markers for another host still count toward the combined lineage/marker row limit.
const MARKERS = 10

describe('accepted completion builds the lineage child index only when a negative check needs it', () => {
  const harness = createOrchestrationRpcHarness()
  let store: Store
  let primary: string
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-pr-bounded-'))
    store = createStore()
    const pPath = join(testState.dir, 'p'),
      qPath = join(testState.dir, 'q')
    mkdirSync(pPath, { recursive: true })
    mkdirSync(qPath, { recursive: true })
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
    store.setWorktreeMeta(hostWorktreeTarget({ id: primary, hostId: 'local' }), {
      instanceId: 'primary-instance',
      createdAt: 1
    })
  })
  afterEach(async () => {
    harness.cleanup()
    vi.restoreAllMocks()
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  /** Saves `rows` lineage rows beside the primary plus MARKERS other-host markers, then invalidates
   *  the child index with one ordinary lineage write so the next send starts cold. */
  const seedRows = (rows: number) => {
    const lineage = store.getAllWorktreeLineage()
    for (let i = 0; i < rows - 1; i++) {
      lineage[`${primary}-sibling-${i}`] = {
        worktreeId: `${primary}-sibling-${i}`,
        worktreeInstanceId: 'x',
        parentWorktreeId: primary,
        parentWorktreeInstanceId: 'primary-instance',
        origin: 'cli',
        capture: { source: 'explicit-cli-flag', confidence: 'explicit' },
        createdAt: 1
      }
    }
    // The getter returns a throwaway {} until a marker exists, so seed the Store's own map.
    const state = (
      store as unknown as {
        state: { workspaceLineageUncertaintyByChild?: Record<string, true> }
      }
    ).state
    const markers = (state.workspaceLineageUncertaintyByChild ??= {})
    for (let i = 0; i < MARKERS; i++) {
      markers[JSON.stringify(['ssh:other', `worktree:p::/elsewhere/${i}`])] = true
    }
    // One real write: saves the lineage domains, which drops any cached index.
    const last = `${primary}-sibling-last`
    store.setWorktreeMeta(hostWorktreeTarget({ id: last, hostId: 'local' }), {
      instanceId: 'last',
      createdAt: 1
    })
    store.setWorktreeLineage(hostWorktreeTarget({ id: last, hostId: 'local' }), {
      worktreeId: last,
      worktreeInstanceId: 'last',
      parentWorktreeId: primary,
      parentWorktreeInstanceId: 'primary-instance',
      origin: 'cli',
      capture: { source: 'explicit-cli-flag', confidence: 'explicit' },
      createdAt: 1
    })
    // setWorktreeLineage also writes the canonical workspace row for the last child.
    expect(
      Object.keys(store.getAllWorktreeLineage()).length +
        Object.keys(store.getAllWorkspaceLineage()).length +
        Object.keys(store.getWorkspaceLineageUncertainty()).length
    ).toBe(rows + 1 + MARKERS)
  }

  const send = async (subject: string, spec = 'Make the change') => {
    harness.cleanup()
    const { db, ctx } = harness.setup(true, store)
    const task = db.createTask({ spec })
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
        subject,
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

  const spyBuild = () => vi.spyOn(childIndexModule, 'buildLineageChildIndex')
  // Keys the builder visited, read from what each build returned.
  const visited = (build: ReturnType<typeof spyBuild>) =>
    build.mock.results.map((result) => (result.value as childIndexModule.LineageChildIndex).size)

  it.each([
    ['no reference', 'Done, tests pass', 'Make the change'],
    ['a reference the assignment names', 'Opened org/q#17', 'Fix org/q#17'],
    ["a reference to the worker's own repository", 'Opened org/p#5', 'Make the change']
  ])('does not build the index for %s, even over the row limit', async (_name, subject, spec) => {
    seedRows(LINEAGE_SCAN_ROW_LIMIT * 2)
    const build = spyBuild()
    expect(await send(subject, spec)).toEqual({
      version: 1,
      state: 'complete',
      outside: []
    })
    expect(build).not.toHaveBeenCalled()
  })

  it('warns at exactly the combined limit, building once and reusing the index', async () => {
    // rows + the last child's canonical row + markers = the limit
    seedRows(LINEAGE_SCAN_ROW_LIMIT - MARKERS - 1)
    const build = spyBuild()
    const warned = { version: 1, state: 'complete', outside: [Q17] }
    expect(await send('Opened org/q#17')).toEqual(warned)
    expect(visited(build)).toEqual([LINEAGE_SCAN_ROW_LIMIT - MARKERS])
    expect(await send('Opened org/q#17')).toEqual(warned)
    expect(build).toHaveBeenCalledTimes(1)
  })

  it('stays unknown one row over the combined limit, scanning at most one row past it', async () => {
    seedRows(LINEAGE_SCAN_ROW_LIMIT - MARKERS)
    const build = spyBuild()
    const unknown = { version: 1, state: 'partial', outside: [] }
    expect(await send('Opened org/q#17')).toEqual(unknown)
    expect(visited(build)).toEqual([LINEAGE_SCAN_ROW_LIMIT - MARKERS + 1])
    // The cached overflow is reused as incomplete; it never certifies absence.
    expect(await send('Opened org/q#17')).toEqual(unknown)
    expect(build).toHaveBeenCalledTimes(1)
  })

  it('bounds construction far over the limit after a cold start', async () => {
    seedRows(LINEAGE_SCAN_ROW_LIMIT * 4)
    await store.flushPendingOrThrowAsync()
    store = createStore()
    const build = spyBuild()
    expect(await send('Opened org/q#17')).toEqual({
      version: 1,
      state: 'partial',
      outside: []
    })
    expect(visited(build)).toEqual([LINEAGE_SCAN_ROW_LIMIT - MARKERS + 1])
  })
})
