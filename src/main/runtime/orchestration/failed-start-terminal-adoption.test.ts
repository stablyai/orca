import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'

const HANDLE = 'term_residual'
const PANE_KEY = 'tab_residual:leaf_residual'
const INCARNATION = 'runtime:pty-residual:1'

describe('a start that fails before authority still owns the terminal it created', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
  })

  /** Replays the shipping order: readiness stage records the handle, then the wait fails. */
  function failStartAfterCreatingTerminal(
    adoption?: Parameters<OrchestrationDb['failWorkerStart']>[3]
  ): { db: OrchestrationDb; dispatchId: string } {
    const d = (db = new OrchestrationDb(':memory:'))
    const task = d.createTask({ spec: 'residual terminal' })
    const started = d.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {}
    })
    const effects = [
      { kind: 'terminal', role: 'agent', action: 'created', id: HANDLE, surface: 'visible' }
    ]
    d.recordWorkerStage({
      dispatchId: started.dispatch.id,
      stage: 'terminal_readying',
      worktreeId: 'repo::worktree',
      terminalHandle: HANDLE,
      effects,
      residualResources: effects
    })
    d.failWorkerStart(
      started.dispatch.id,
      'agent_readiness',
      'Agent startup blocked: codex-interactive-prompt',
      adoption
    )
    return { db: d, dispatchId: started.dispatch.id }
  }

  const adoption = {
    adoptResidualTerminal: {
      terminalHandle: HANDLE,
      worktreeId: 'repo::worktree',
      paneKey: PANE_KEY,
      processIncarnation: INCARNATION,
      hostScope: null
    }
  }

  it('leaves nothing that can close the terminal when the start is not adopted', () => {
    const { db: d, dispatchId } = failStartAfterCreatingTerminal()

    expect(d.getWorkerTerminalResourceByOwner(dispatchId)).toBeUndefined()
    expect(d.requestWorkerTerminalRelease(dispatchId)).toMatchObject({
      disposition: 'retained',
      reason: 'no_owned_resource'
    })
  })

  it('records the ownership the successful path would have recorded', () => {
    const { db: d, dispatchId } = failStartAfterCreatingTerminal(adoption)

    expect(d.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
      owner_dispatch_id: dispatchId,
      terminal_handle: HANDLE,
      pane_key: PANE_KEY,
      process_incarnation: INCARNATION,
      ownership_state: 'owned',
      release_state: 'not_requested'
    })
  })

  it('lets worker-release proceed on the failed dispatch', () => {
    const { db: d, dispatchId } = failStartAfterCreatingTerminal(adoption)

    expect(d.requestWorkerTerminalRelease(dispatchId)).toMatchObject({
      disposition: 'requested',
      resource: { release_state: 'requested' }
    })
  })

  it('re-proves identity through the dispatch context release reads', () => {
    const { db: d, dispatchId } = failStartAfterCreatingTerminal(adoption)

    expect(
      d.isDispatchProcessCurrent({ dispatchId, paneKey: PANE_KEY, processIncarnation: INCARNATION })
    ).toBe(true)
    // Adoption records which pane the dispatch owns; it never restores authority over it.
    expect(d.getDispatchContextById(dispatchId)).toMatchObject({
      status: 'failed',
      capability_hash: null
    })
    expect(d.getDispatchContextById(dispatchId)?.capability_revoked_at).not.toBeNull()
  })

  it('publishes the terminal as reclaimable so the fleet names release', () => {
    const { db: d, dispatchId } = failStartAfterCreatingTerminal(adoption)

    expect(d.listWorkerTerminalResources({ dispatchIds: [dispatchId] })[0]).toMatchObject({
      agentTerminalHandle: HANDLE,
      terminalState: 'reclaimable'
    })
  })

  it('never claims a terminal the durable row does not name', () => {
    const { db: d, dispatchId } = failStartAfterCreatingTerminal({
      adoptResidualTerminal: { ...adoption.adoptResidualTerminal, terminalHandle: 'term_other' }
    })

    expect(d.getWorkerTerminalResourceByOwner(dispatchId)).toBeUndefined()
  })

  it('never claims a terminal another live resource already accounts for', () => {
    const d = (db = new OrchestrationDb(':memory:'))
    const first = d.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: d.createTask({ spec: 'owner' }).id,
      startOptions: {}
    })
    d.prepareStartingWorkerAuthority({
      dispatchId: first.dispatch.id,
      handle: HANDLE,
      paneKey: PANE_KEY,
      processIncarnation: INCARNATION,
      worktreeId: 'repo::worktree',
      setupState: 'not_applicable',
      effects: [],
      terminalOwnership: 'created'
    })
    const second = d.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: d.createTask({ spec: 'claimant' }).id,
      startOptions: {}
    })
    d.recordWorkerStage({
      dispatchId: second.dispatch.id,
      stage: 'terminal_readying',
      terminalHandle: HANDLE
    })

    d.failWorkerStart(second.dispatch.id, 'agent_readiness', 'blocked', adoption)

    expect(d.getWorkerTerminalResourceByOwner(second.dispatch.id)).toBeUndefined()
    expect(d.getWorkerTerminalResourceByOwner(first.dispatch.id)).toMatchObject({
      ownership_state: 'owned'
    })
  })
})
