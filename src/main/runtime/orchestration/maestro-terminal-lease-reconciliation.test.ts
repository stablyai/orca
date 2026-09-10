import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPtyStopReceipt } from '../../../shared/pty-stop-receipt'
import { OrcaRuntimeService } from '../orca-runtime'
import { OrchestrationDb } from './db'
import { recordMaestroProviderRollover } from './db/maestro-terminal-lease/maestro-provider-rollover-store'
import {
  adoptCurrentCoordinatorLease,
  reconcileMaestroTerminalLease
} from './maestro-terminal-lease-reconciliation'

describe('Maestro terminal lease reconciliation', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
  })

  function setup() {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    const lease = db.reserveMaestroTerminalLease({
      requestId: 'coordinator:g1',
      executionHostId: 'local',
      workspaceKey: 'folder:one',
      runId: 'run_1',
      coordinatorGeneration: 1,
      role: 'coordinator',
      coordinatorRunId: 'run_1',
      title: 'Harness · coordinator g1 · Codex',
      launchProfile: {
        agent: 'codex',
        model: null,
        effort: null,
        permissionMode: 'yolo',
        routeRef: null
      },
      spawnedBy: 'bootstrap',
      ownerPrincipal: 'coordinator:g1',
      retentionPolicy: 'auto_release'
    })
    db.attachMaestroTerminalLease({
      leaseId: lease.id,
      terminalHandle: 'term_1',
      tabId: 'tab_1',
      paneKey: 'tab_1:leaf_1',
      ptyIncarnation: 'pty_1:inc_1',
      processRootId: 'pty_1'
    })
    db.transitionMaestroTerminalLease({ leaseId: lease.id, state: 'ready' })
    db.transitionMaestroTerminalLease({ leaseId: lease.id, state: 'active' })
    return { runtime, lease }
  }

  function exitedStopReceipt() {
    const root = {
      pid: 123,
      parentPid: 1,
      processGroupId: 123,
      startedAt: '2026-08-24T12:00:00.000Z'
    }
    return createPtyStopReceipt({
      executionHostId: 'local',
      terminalHandle: 'term_1',
      ptyId: 'pty_1',
      ptyIncarnation: 'pty_1:inc_1',
      root,
      descendants: [],
      observations: [{ identity: root, status: 'absent', observedAt: '2026-08-24T12:00:01.000Z' }],
      verdict: 'exited',
      processTreeVerified: true
    })
  }

  it('retains the current coordinator', async () => {
    const { runtime, lease } = setup()
    const close = vi.spyOn(runtime, 'closeTerminal')

    const result = await reconcileMaestroTerminalLease({
      runtime,
      leaseId: lease.id,
      currentCoordinatorGeneration: 1
    })

    expect(result.action).toBe('retained')
    expect(close).not.toHaveBeenCalled()
  })

  it('closes only the exact fenced incarnation and archives a bounded tail', async () => {
    const { runtime, lease } = setup()
    vi.spyOn(runtime, 'proveManagedTerminalIdentity').mockReturnValue(true)
    vi.spyOn(runtime, 'readTerminal').mockResolvedValue({
      handle: 'term_1',
      status: 'running',
      tail: ['bounded output'],
      truncated: false,
      nextCursor: null
    })
    vi.spyOn(runtime, 'closeTerminal').mockResolvedValue({
      handle: 'term_1',
      tabId: 'tab_1',
      ptyKilled: true,
      ptyStopReceipt: exitedStopReceipt()
    })

    const result = await reconcileMaestroTerminalLease({
      runtime,
      leaseId: lease.id,
      currentCoordinatorGeneration: 2
    })

    expect(result.action).toBe('released')
    expect(db!.getMaestroTerminalLease(lease.id)).toMatchObject({
      lifecycleState: 'released',
      archivedTail: 'bounded output'
    })
  })

  it('treats a legacy killed boolean without an exact receipt as outcome unknown', async () => {
    const { runtime, lease } = setup()
    vi.spyOn(runtime, 'proveManagedTerminalIdentity').mockReturnValue(true)
    vi.spyOn(runtime, 'readTerminal').mockResolvedValue({
      handle: 'term_1',
      status: 'running',
      tail: [],
      truncated: false,
      nextCursor: null
    })
    vi.spyOn(runtime, 'closeTerminal').mockResolvedValue({
      handle: 'term_1',
      tabId: 'tab_1',
      ptyKilled: true
    })

    const result = await reconcileMaestroTerminalLease({
      runtime,
      leaseId: lease.id,
      currentCoordinatorGeneration: 2
    })

    expect(result).toMatchObject({
      action: 'outcome_unknown',
      cleanupReceipt: { verdict: 'unverifiable', processTreeVerified: false }
    })
  })

  it('retains an adopted external coordinator without assuming cleanup authority', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'showTerminal').mockResolvedValue({
      handle: 'term_external',
      tabId: 'tab_external'
    } as never)
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockReturnValue('pty_external:inc_1')
    vi.spyOn(runtime, 'buildTerminalManagedCliContext').mockReturnValue({
      executionHostId: 'local',
      workspaceKey: 'folder:one'
    } as never)

    await adoptCurrentCoordinatorLease({
      runtime,
      runId: 'run_external',
      generation: 1,
      terminalHandle: 'term_external',
      paneKey: 'tab_external:leaf_1',
      agent: 'codex',
      spawnedBy: 'bootstrap'
    })
    const lease = db.getCoordinatorLease('run_external', 1)!
    const close = vi.spyOn(runtime, 'closeTerminal')
    const result = await reconcileMaestroTerminalLease({
      runtime,
      leaseId: lease.id,
      currentCoordinatorGeneration: 2
    })

    expect(result.action).toBe('retained')
    expect(db.getMaestroTerminalLease(lease.id)).toMatchObject({
      lifecycleState: 'retained',
      retentionPolicy: 'retain',
      ownerPrincipal: 'external-coordinator:run_external:g1',
      launchProfile: { routeRef: 'adopted-external-coordinator' }
    })
    expect(close).not.toHaveBeenCalled()
  })

  it('rebinds one current-generation lease to the authenticated restart incarnation', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    const run = db.createRun({
      objective: 'Recover after restart',
      coordinatorHandle: 'term_current',
      coordinatorPaneKey: 'tab_current:leaf_current'
    })
    const lease = db.reserveMaestroTerminalLease({
      requestId: `coordinator:${run.id}:g1`,
      executionHostId: 'local',
      workspaceKey: 'folder:one',
      runId: run.id,
      coordinatorGeneration: 1,
      role: 'coordinator',
      coordinatorRunId: run.id,
      title: 'Coordinator before restart',
      launchProfile: {
        agent: 'codex',
        model: null,
        effort: null,
        permissionMode: 'unknown',
        routeRef: 'adopted-external-coordinator'
      },
      spawnedBy: 'authenticated-before-restart',
      ownerPrincipal: `external-coordinator:${run.id}:g1`,
      retentionPolicy: 'retain'
    })
    db.attachMaestroTerminalLease({
      leaseId: lease.id,
      terminalHandle: 'term_before_restart',
      tabId: 'tab_before_restart',
      paneKey: 'tab_before_restart:leaf_before_restart',
      ptyIncarnation: 'pty_before_restart:1',
      processRootId: 'pty_before_restart'
    })
    db.retainMaestroTerminalLease(lease.id)
    vi.spyOn(runtime, 'showTerminal').mockResolvedValue({
      handle: 'term_current',
      tabId: 'tab_current',
      ptyId: 'pty_current',
      agentIdentity: 'codex'
    } as never)
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockReturnValue('pty_current:2')
    vi.spyOn(runtime, 'buildTerminalManagedCliContext').mockReturnValue({
      executionHostId: 'local',
      workspaceKey: 'folder:one'
    } as never)

    await adoptCurrentCoordinatorLease({
      runtime,
      runId: run.id,
      generation: 1,
      terminalHandle: 'term_current',
      paneKey: 'tab_current:leaf_current',
      spawnedBy: 'authenticated-after-restart',
      callerAuthority: {
        hostScope: { kind: 'local', hostId: 'local' },
        terminalHandle: 'term_current',
        paneKey: 'tab_current:leaf_current',
        processIncarnation: 'pty_current:2',
        launchTokenHash: 'launch-token-after-restart'
      }
    })

    expect(db.getCoordinatorLease(run.id, 1)).toMatchObject({
      id: lease.id,
      terminalHandle: 'term_current',
      tabId: 'tab_current',
      paneKey: 'tab_current:leaf_current',
      ptyIncarnation: 'pty_current:2',
      lifecycleState: 'retained'
    })
    expect(
      db.db
        .prepare(
          "SELECT COUNT(*) AS count FROM maestro_terminal_leases WHERE run_id = ? AND role = 'coordinator'"
        )
        .get(run.id)
    ).toEqual({ count: 1 })
  })

  it('refuses to rebind an existing coordinator lease without caller authority', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    const run = db.createRun({
      objective: 'Reject unauthenticated restart',
      coordinatorHandle: 'term_current',
      coordinatorPaneKey: 'tab_current:leaf_current'
    })
    const lease = db.reserveMaestroTerminalLease({
      requestId: `coordinator:${run.id}:g1`,
      executionHostId: 'local',
      workspaceKey: 'folder:one',
      runId: run.id,
      coordinatorGeneration: 1,
      role: 'coordinator',
      coordinatorRunId: run.id,
      title: 'Coordinator before restart',
      launchProfile: {
        agent: 'codex',
        model: null,
        effort: null,
        permissionMode: 'unknown',
        routeRef: 'adopted-external-coordinator'
      },
      spawnedBy: 'authenticated-before-restart',
      ownerPrincipal: `external-coordinator:${run.id}:g1`,
      retentionPolicy: 'retain'
    })
    db.attachMaestroTerminalLease({
      leaseId: lease.id,
      terminalHandle: 'term_before_restart',
      tabId: 'tab_before_restart',
      paneKey: 'tab_before_restart:leaf_before_restart',
      ptyIncarnation: 'pty_before_restart:1',
      processRootId: 'pty_before_restart'
    })
    vi.spyOn(runtime, 'showTerminal').mockResolvedValue({
      handle: 'term_current',
      tabId: 'tab_current',
      ptyId: 'pty_current'
    } as never)
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockReturnValue('pty_current:2')
    vi.spyOn(runtime, 'buildTerminalManagedCliContext').mockReturnValue({
      executionHostId: 'local',
      workspaceKey: 'folder:one'
    } as never)

    await expect(
      adoptCurrentCoordinatorLease({
        runtime,
        runId: run.id,
        generation: 1,
        terminalHandle: 'term_current',
        paneKey: 'tab_current:leaf_current',
        spawnedBy: 'unauthenticated-after-restart'
      })
    ).rejects.toMatchObject({ code: 'consumer_fenced' })
    expect(db.getCoordinatorLease(run.id, 1)).toMatchObject({
      terminalHandle: 'term_before_restart',
      ptyIncarnation: 'pty_before_restart:1'
    })
  })

  it('records controlled provider rollover without resuming or killing the current process', () => {
    const { runtime, lease } = setup()
    const close = vi.spyOn(runtime, 'closeTerminal')

    recordMaestroProviderRollover(db!, lease.id, 'context_rollover')

    expect(db!.getMaestroTerminalLease(lease.id)).toMatchObject({
      lifecycleState: 'outcome_unknown',
      retentionPolicy: 'retain',
      observation: 'context_rollover'
    })
    expect(close).not.toHaveBeenCalled()
  })

  it('binds a racing replacement and refuses to settle its predecessor release', async () => {
    const { runtime, lease } = setup()
    vi.spyOn(runtime, 'proveManagedTerminalIdentity').mockReturnValue(true)
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockImplementation((handle) =>
      handle === 'term_1' ? 'pty_1:inc_1' : 'pty_2:inc_1'
    )
    vi.spyOn(runtime, 'readTerminal').mockResolvedValue({
      handle: 'term_1',
      status: 'running',
      tail: [],
      truncated: false,
      nextCursor: null
    })
    vi.spyOn(runtime, 'closeTerminal').mockResolvedValue({
      handle: 'term_1',
      tabId: 'tab_1',
      ptyKilled: true,
      ptyStopReceipt: exitedStopReceipt()
    })
    vi.spyOn(runtime, 'listTerminals').mockResolvedValue({
      terminals: [{ handle: 'term_2', tabId: 'tab_1' }],
      totalCount: 1,
      truncated: false
    } as never)

    const result = await reconcileMaestroTerminalLease({
      runtime,
      leaseId: lease.id,
      currentCoordinatorGeneration: 2
    })

    expect(result).toMatchObject({
      action: 'outcome_unknown',
      cleanupReceipt: {
        replacementTerminalHandle: 'term_2',
        replacementIncarnation: 'pty_2:inc_1'
      }
    })
    expect(db!.getMaestroTerminalLease(lease.id)?.lifecycleState).toBe('outcome_unknown')
  })

  it('does not close a fenced lease whose host or pane identity is unverifiable', async () => {
    const { runtime, lease } = setup()
    vi.spyOn(runtime, 'proveManagedTerminalIdentity').mockReturnValue(false)
    const close = vi.spyOn(runtime, 'closeTerminal')

    const result = await reconcileMaestroTerminalLease({
      runtime,
      leaseId: lease.id,
      currentCoordinatorGeneration: 2
    })

    expect(result.action).toBe('outcome_unknown')
    expect(close).not.toHaveBeenCalled()
  })
})
