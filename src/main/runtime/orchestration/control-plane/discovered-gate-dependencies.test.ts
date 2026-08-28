import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../db'
import { completionGateInputs } from './completion-gate-inputs'
import { createObservedWorktree, type ObservedWorktreeFixture } from './observed-worktree-fixture'

/** GATE_DEPENDENCIES_WERE_CALLER_DECLARED — the gate receipt fingerprinted
 *  exactly the files the WORKER said it touched, so a worker that under-reported
 *  produced a receipt nothing it actually changed could ever invalidate.
 */
describe('GATE_DEPENDENCIES_WERE_CALLER_DECLARED', () => {
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

  it('fingerprints a file Git saw change even when the worker never declared it', () => {
    tree = createObservedWorktree()
    tree.commit('undeclared.ts')
    const dispatchId = dispatchIn(tree.worktreeId)
    const inputs = completionGateInputs(db!, dispatchId, [], 'v1', 'pnpm test')
    expect(Object.keys(inputs.inputHashes)).toContain('file:undeclared.ts')
    // A real content hash, not a placeholder: this receipt dies if the file does.
    expect(inputs.inputHashes['file:undeclared.ts']).toMatch(/^[0-9a-f]{16,}$/)
    expect(inputs.shaBinding).toBe('content')
  })

  it('keeps a file the worker declared that Git did not report', () => {
    tree = createObservedWorktree()
    tree.commit('seen.ts')
    const dispatchId = dispatchIn(tree.worktreeId)
    const inputs = completionGateInputs(db!, dispatchId, ['a.txt'], 'v1', 'pnpm test')
    expect(Object.keys(inputs.inputHashes).sort()).toEqual([
      'config:commandIdentity',
      'config:policyVersion',
      'file:a.txt',
      'file:seen.ts'
    ])
  })

  it('negative control: an unreadable tree falls back to the claim and never reuses', () => {
    const dispatchId = dispatchIn('repo::/nope/gone')
    const inputs = completionGateInputs(db!, dispatchId, ['x.ts'], 'v1', 'g')
    expect(inputs).toMatchObject({ shaBinding: 'exact_head' })
    expect(inputs.inputHashes['files:unreadable']).toBe('x.ts')
  })
})
