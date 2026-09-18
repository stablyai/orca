import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './orchestration-db'
import { structuredAgentSessionTabId } from '../../../../shared/structured-agent-session-tab-id'

const LEAF1 = '11111111-1111-4111-8111-111111111111'
const LEAF2 = '22222222-2222-4222-8222-222222222222'
const PANE_A = `tab_a:${LEAF1}`
const PANE_B = `tab_b:${LEAF2}`

describe('principal dual-write', () => {
  let db: OrchestrationDb

  afterEach(() => db?.close())

  function readDispatch(id: string) {
    return db.db
      .prepare('SELECT assignee_principal, creator_principal FROM dispatch_contexts WHERE id = ?')
      .get(id) as { assignee_principal: string | null; creator_principal: string | null }
  }

  it('createRun, bindRun, and unbind track the coordinator principal', () => {
    db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'principals',
      coordinatorHandle: 'term_a',
      coordinatorPaneKey: PANE_A
    })
    expect(run.coordinator_principal).toBe(`pane:${PANE_A}`)

    const rebound = db.bindRun({
      runId: run.id,
      coordinatorHandle: 'term_b',
      coordinatorPaneKey: PANE_B
    })
    expect(rebound?.coordinator_principal).toBe(`pane:${PANE_B}`)

    // A second Run claiming the same pane unbinds the first; a stale principal would misattribute
    // the Run once reads flip.
    db.createRun({ objective: 'usurper', coordinatorHandle: 'term_c', coordinatorPaneKey: PANE_B })
    expect(db.getRunRaw(run.id)?.coordinator_principal).toBeNull()
    expect(db.getRunRaw(run.id)?.coordinator_pane_key).toBeNull()
  })

  it('still caches both handles across a same-pane rebind', () => {
    db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'remint',
      coordinatorHandle: 'term_a',
      coordinatorPaneKey: PANE_A
    })
    db.bindRun({ runId: run.id, coordinatorHandle: 'term_reminted', coordinatorPaneKey: PANE_A })
    expect(
      db.db
        .prepare(
          'SELECT terminal_handle FROM run_coordinator_handles WHERE run_id = ? ORDER BY terminal_handle'
        )
        .all(run.id)
    ).toEqual([{ terminal_handle: 'term_a' }, { terminal_handle: 'term_reminted' }])
  })

  it('classifies a structured coordinator pane key to its session principal at createRun', () => {
    db = new OrchestrationDb(':memory:')
    const paneKey = `${structuredAgentSessionTabId('sess_run')}:${LEAF1}`
    const run = db.createRun({
      objective: 'structured',
      coordinatorHandle: 'structworker_a',
      coordinatorPaneKey: paneKey
    })
    expect(run.coordinator_principal).toBe('session:sess_run')
    // COALESCE: the handle wins the cache address while one exists; the principal takes over only
    // for a handle-less session coordinator (a later PR's writer).
    expect(
      db.db
        .prepare('SELECT terminal_handle FROM run_coordinator_handles WHERE run_id = ?')
        .get(run.id)
    ).toEqual({ terminal_handle: 'structworker_a' })
  })

  it('createDispatchContext writes assignee and creator principals by classification', () => {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ runId: 'run_legacy_local', spec: 'assigned' })
    const withPane = db.createDispatchContext({
      taskId: task.id,
      assigneeHandle: 'term_w',
      assigneePaneKey: PANE_A,
      creator: { kind: 'terminal', handle: 'term_creator', paneKey: PANE_B },
      maxDepth: Number.MAX_SAFE_INTEGER
    })
    expect(readDispatch(withPane.id)).toEqual({
      assignee_principal: `pane:${PANE_A}`,
      creator_principal: `pane:${PANE_B}`
    })

    const task2 = db.createTask({ runId: 'run_legacy_local', spec: 'bare' })
    const bare = db.createDispatchContext({
      taskId: task2.id,
      assigneeHandle: 'term_bare',
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER
    })
    expect(readDispatch(bare.id)).toEqual({ assignee_principal: null, creator_principal: null })
  })

  it('classifies a structured assignee pane key at the writer chokepoint', () => {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ runId: 'run_legacy_local', spec: 'structured worker' })
    const paneKey = `${structuredAgentSessionTabId('sess_w')}:${LEAF1}`
    const dispatch = db.createDispatchContext({
      taskId: task.id,
      assigneeHandle: 'structworker_w',
      assigneePaneKey: paneKey,
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER
    })
    expect(readDispatch(dispatch.id).assignee_principal).toBe('session:sess_w')
  })

  it('a terminal creator with a handle but no pane key records a NULL creator principal', () => {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ runId: 'run_legacy_local', spec: 'handle-only creator' })
    const dispatch = db.createDispatchContext({
      taskId: task.id,
      assigneeHandle: 'term_w',
      creator: { kind: 'terminal', handle: 'term_creator' },
      maxDepth: Number.MAX_SAFE_INTEGER
    })
    expect(readDispatch(dispatch.id).creator_principal).toBeNull()
  })

  it('worker-start leaves assignee NULL until authority attaches, then tracks re-pointing', () => {
    db = new OrchestrationDb(':memory:')
    const { dispatch } = db.createStartingWorkerDispatch({
      taskSpec: 'supervised',
      taskRunId: 'run_legacy_local',
      startOptions: {},
      creator: { kind: 'terminal', handle: 'term_creator', paneKey: PANE_B },
      maxDepth: Number.MAX_SAFE_INTEGER
    })
    expect(readDispatch(dispatch.id)).toEqual({
      assignee_principal: null,
      creator_principal: `pane:${PANE_B}`
    })

    db.prepareStartingWorkerAuthority({
      dispatchId: dispatch.id,
      handle: 'term_worker',
      paneKey: PANE_A,
      processIncarnation: 'inc-1',
      worktreeId: 'wt-1',
      effects: [],
      setupState: 'not_applicable',
      terminalOwnership: 'created'
    })
    expect(readDispatch(dispatch.id)).toEqual({
      assignee_principal: `pane:${PANE_A}`,
      creator_principal: `pane:${PANE_B}`
    })

    // Re-pointing the Dispatch moves the assignee principal and leaves the creator alone.
    db.mintDispatchCapability({
      dispatchId: dispatch.id,
      paneKey: PANE_B,
      processIncarnation: 'inc-2'
    })
    expect(readDispatch(dispatch.id)).toEqual({
      assignee_principal: `pane:${PANE_B}`,
      creator_principal: `pane:${PANE_B}`
    })
  })

  it('worker terminal resources track pane identity through create and transfer', () => {
    db = new OrchestrationDb(':memory:')
    const owned = db.createWorkerTerminalResourceStatement({
      dispatchId: 'ctx_owner',
      worktreeId: 'wt-1',
      terminalHandle: 'term_w',
      paneKey: PANE_A,
      processIncarnation: 'inc-1',
      ownership: 'owned'
    })
    expect(owned.principal).toBe(`pane:${PANE_A}`)

    const external = db.createWorkerTerminalResourceStatement({
      dispatchId: 'ctx_external',
      worktreeId: 'wt-1',
      terminalHandle: 'term_e',
      paneKey: null,
      processIncarnation: null,
      ownership: 'external'
    })
    expect(external.principal).toBeNull()

    const transferred = db.transferWorkerTerminalResourceStatement({
      resourceId: owned.id,
      toDispatchId: 'ctx_next',
      terminalHandle: 'term_w2',
      paneKey: PANE_B,
      processIncarnation: 'inc-2',
      hostScope: null
    })
    expect(transferred.principal).toBe(`pane:${PANE_B}`)
  })
})
