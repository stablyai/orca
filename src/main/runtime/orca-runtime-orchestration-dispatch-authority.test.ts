import { describe, expect, it } from 'vitest'
import { makePaneKey } from '../../shared/stable-pane-id'
import { OrcaRuntimeService } from './orca-runtime'
import { OrchestrationDb } from './orchestration/db'

const WORKTREE_ID = 'repo::/workspace'
const PTY_ID = 'pty-worker'
const LIVE_TAB_ID = '11111111-1111-4111-8111-111111111111'
const LIVE_LEAF_ID = '22222222-2222-4222-8222-222222222222'
const STALE_TAB_ID = '33333333-3333-4333-8333-333333333333'
const STALE_LEAF_ID = '44444444-4444-4444-8444-444444444444'
const INCARNATION_ID = 'worker-incarnation'

describe('orchestration dispatch authority', () => {
  it('binds a leaf handle to its live pane when the PTY retains another pane', () => {
    const runtime = new OrcaRuntimeService()
    runtime.registerPty(PTY_ID, WORKTREE_ID, null, {
      tabId: LIVE_TAB_ID,
      leafId: LIVE_LEAF_ID,
      incarnationId: INCARNATION_ID
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: LIVE_TAB_ID,
          worktreeId: WORKTREE_ID,
          title: 'Worker',
          activeLeafId: LIVE_LEAF_ID,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: LIVE_TAB_ID,
          worktreeId: WORKTREE_ID,
          leafId: LIVE_LEAF_ID,
          paneRuntimeId: 1,
          ptyId: PTY_ID
        }
      ]
    })
    const livePaneKey = makePaneKey(LIVE_TAB_ID, LIVE_LEAF_ID)
    const terminalHandle = runtime.getTerminalHandleForPaneKey(livePaneKey)
    expect(terminalHandle).not.toBeNull()
    if (!terminalHandle) {
      throw new Error('live worker pane did not issue a terminal handle')
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test reproduces a retained PTY pane binding without rotating its live leaf generation.
    const internals = runtime as unknown as {
      ptysById: Map<string, { paneKey: string | null; tabId: string | null }>
    }
    const pty = internals.ptysById.get(PTY_ID)
    if (!pty) {
      throw new Error('worker PTY was not registered')
    }
    pty.tabId = STALE_TAB_ID
    pty.paneKey = makePaneKey(STALE_TAB_ID, STALE_LEAF_ID)

    expect(runtime.getTerminalPaneKey(terminalHandle)).toBe(livePaneKey)
    const authority = runtime.getOrchestrationDispatchAuthority(terminalHandle)
    expect(authority).toMatchObject({
      terminalHandle,
      ptyId: PTY_ID,
      paneKey: livePaneKey,
      processIncarnation: runtime.getTerminalProcessIncarnation(terminalHandle)
    })
    if (!authority?.paneKey || !authority.processIncarnation) {
      throw new Error('worker authority was incomplete')
    }

    const db = new OrchestrationDb(':memory:')
    const task = db.createTask({ runId: 'run_legacy_local', spec: 'supervised worker' })
    const started = db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {}
    })
    const capability = db.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: terminalHandle,
      paneKey: authority.paneKey,
      processIncarnation: authority.processIncarnation,
      worktreeId: authority.worktreeId,
      effects: [],
      setupState: 'not_applicable',
      terminalOwnership: 'created'
    })
    const callerPaneKey = runtime.getTerminalPaneKey(terminalHandle)
    const callerProcessIncarnation = runtime.getTerminalProcessIncarnation(terminalHandle)
    if (!callerPaneKey || !callerProcessIncarnation) {
      throw new Error('worker caller identity was incomplete')
    }

    expect(
      db.verifyDispatchCapability({
        dispatchId: started.dispatch.id,
        capability,
        paneKey: callerPaneKey,
        processIncarnation: callerProcessIncarnation
      })
    ).toEqual({ valid: true })
    db.close()
  })
})
