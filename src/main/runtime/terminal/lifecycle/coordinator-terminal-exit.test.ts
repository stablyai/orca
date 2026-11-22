import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db/orchestration-db'
import { getQuestionTaker } from '../../orchestration/db/messages/mail-taker'
import { dropReaderlessRunQuestions } from '../../orchestration/db/questions/readerless-run-questions'
import { getDefaultWorkspaceSession } from '../../../../shared/orca-profiles/constants'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import { withDurableRuntimeStore } from '../../construction/test-context/runtime-durable-store-fixture'

const LEAF = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const PANE = `tab_c:${LEAF}`
const OTHER_LEAF = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

describe("a Run whose coordinator's terminal ended", () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let runId: string
  let dispatchId: string

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService(null)
    runtime.setOrchestrationDb(db)
    runtime.registerPty('pty-c', 'wt', null, {
      tabId: 'tab_c',
      leafId: LEAF,
      terminalHandle: 'term_c'
    })
    runId = db.createRun({
      objective: 'o',
      coordinatorHandle: 'term_c',
      coordinatorPaneKey: PANE,
      coordinatorOrcaSessionId: null
    }).id
    const task = db.createTask({ spec: 'w', runId })
    dispatchId = db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {}
    }).dispatch.id
    db.markWorkerDispatchReady(dispatchId)
  })
  afterEach(() => db.close())

  /** As ask admission does. */
  function ask(): string {
    const { message } = db.createQuestion({
      runId,
      dispatchId,
      askerHandle: 'term_w',
      question: 'Red or blue?'
    })
    dropReaderlessRunQuestions(db, runId)
    return message.id
  }

  it('tells the open ask and every later one that no one will read it', async () => {
    const open = ask()
    expect(getQuestionTaker(db, open)).toBeNull()

    await runtime.onPtyExit('pty-c', 0)

    expect(getQuestionTaker(db, open)).toBe('dropped:no-reader')
    expect(getQuestionTaker(db, ask())).toBe('dropped:no-reader')
    // Still unread, so a coordinator that takes the Run over can answer it.
    expect(db.getQuestionRaw(open)?.status).toBe('pending')
  })

  it('keeps its coordinator through a restart in place', async () => {
    runtime.intentionalPtyStops.mark('pty-c', 'replaced', null)
    await runtime.onPtyExit('pty-c', 0)
    expect(getQuestionTaker(db, ask())).toBeNull()
  })

  it('reads again once run-use binds the Run to a new terminal', async () => {
    await runtime.onPtyExit('pty-c', 0)
    expect(getQuestionTaker(db, ask())).toBe('dropped:no-reader')
    db.bindRun({ runId, coordinatorHandle: 'term_n', coordinatorPaneKey: `tab_n:${OTHER_LEAF}` })
    expect(getQuestionTaker(db, ask())).toBeNull()
  })

  /** Closes slept tab_s from the window; `moved` also keeps its leaf in another tab, as a move does. */
  async function closeSleptTab(moved: boolean): Promise<string> {
    const leaf = { type: 'leaf' as const, leafId: OTHER_LEAF }
    const layout = { root: leaf, activeLeafId: OTHER_LEAF, expandedLeafId: null }
    let session: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {
        wt: [
          {
            id: 'tab_s',
            ptyId: null,
            worktreeId: 'wt',
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      terminalLayoutsByTabId: { tab_s: layout, ...(moved ? { tab_m: layout } : {}) }
    }
    const store = withDurableRuntimeStore({
      getWorkspaceSession: () => session,
      setWorkspaceSession: (next: WorkspaceSessionState) => {
        session = next
      },
      getSettings: () => ({}),
      flushOrThrow: () => undefined
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake carries every store method a renderer close reaches.
    const window = new OrcaRuntimeService(store as never)
    window.setOrchestrationDb(db)
    db.bindRun({ runId, coordinatorHandle: null, coordinatorPaneKey: `tab_s:${OTHER_LEAF}` })
    const open = ask()
    await window.closeTerminalSurfaceFromRenderer({
      worktreeId: 'wt',
      target: { kind: 'tab', tabId: 'tab_s' },
      reason: 'user'
    })
    expect(session.terminalLayoutsByTabId.tab_s).toBeUndefined()
    return open
  }

  it('retires a slept coordinator tab closed without waking, which ends no terminal', async () => {
    expect(getQuestionTaker(db, await closeSleptTab(false))).toBe('dropped:no-reader')
  })

  it('keeps a Run whose pane moved to another tab before its old tab closed', async () => {
    expect(getQuestionTaker(db, await closeSleptTab(true))).toBeNull()
  })
})
