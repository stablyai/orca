import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../db'
import { observeCompletion } from './runtime-observed-completion'
import { createObservedWorktree, type ObservedWorktreeFixture } from './observed-worktree-fixture'

/** A `git diff` failure against a recorded base was swallowed to an empty list
 *  while the observation still reported `observable: true`, so a completion
 *  settled claiming it had delivered no files at all. "Could not read the diff"
 *  must never read as "nothing changed".
 */
describe('an unreadable diff is not the same as no changes', () => {
  let db: OrchestrationDb | undefined
  let tree: ObservedWorktreeFixture | undefined
  afterEach(() => {
    db?.close()
    db = undefined
    tree?.cleanup()
    tree = undefined
  })

  function dispatchIn(worktreeId: string): string {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ spec: 'work' })
    const started = db.createStartingWorkerDispatch({
      taskId: task.id,
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      startOptions: { agent: 'claude' }
    })
    db.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: 'term_worker',
      paneKey: 'term_worker:leaf',
      processIncarnation: 'pty:term_worker',
      launchTokenHash: 'hash',
      worktreeId,
      effects: [],
      setupState: 'not_applicable',
      terminalOwnership: 'created'
    })
    db.markWorkerDispatchReady(started.dispatch.id, [])
    return started.dispatch.id
  }

  it('reports unobservable when the recorded base cannot be resolved', () => {
    tree = createObservedWorktree()
    tree.commit('delivered.ts')
    const dispatchId = dispatchIn(tree.worktreeId)

    const result = observeCompletion({ db: db!, dispatchId, baseSha: '0'.repeat(40) })

    expect(result.observable).toBe(false)
    expect(result.reason).toContain('could not be read')
  })

  it('still reports an empty changed set for a real no-change dispatch', () => {
    tree = createObservedWorktree()
    const dispatchId = dispatchIn(tree.worktreeId)

    const result = observeCompletion({ db: db!, dispatchId, baseSha: tree.headSha })

    expect(result.observable).toBe(true)
    expect(result.changedFiles).toEqual([])
  })

  // The no-base fallback used to swallow EVERY failure to [] because the
  // `HEAD^..HEAD` range form throws on a parentless commit. It now uses
  // `diff-tree --root`, which handles that natively, so the catch fails closed
  // for everything and a root commit reports what it actually added.
  it("reports a root commit's own files when no base was recorded", () => {
    tree = createObservedWorktree()
    const dispatchId = dispatchIn(tree.worktreeId)

    const result = observeCompletion({ db: db!, dispatchId, baseSha: null })

    expect(result.observable).toBe(true)
    expect(result.changedFiles).toEqual(['a.txt'])
  })

  it('still reports the real changed set for a delivered commit', () => {
    tree = createObservedWorktree()
    const base = tree.headSha
    tree.commit('delivered.ts')
    const dispatchId = dispatchIn(tree.worktreeId)

    const result = observeCompletion({ db: db!, dispatchId, baseSha: base })

    expect(result.observable).toBe(true)
    expect(result.changedFiles).toEqual(['delivered.ts'])
  })
})
