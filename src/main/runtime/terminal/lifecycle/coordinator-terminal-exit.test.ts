import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db/orchestration-db'
import { getQuestionTaker } from '../../orchestration/db/messages/mail-taker'
import { dropReaderlessRunQuestions } from '../../orchestration/db/questions/readerless-run-questions'

const LEAF = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const PANE = `tab_c:${LEAF}`

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

  it('keeps its coordinator through a restart in place, and run-use binds a new one', async () => {
    runtime.intentionalPtyStops.mark('pty-c', 'replaced', null)
    await runtime.onPtyExit('pty-c', 0)
    expect(getQuestionTaker(db, ask())).toBeNull()

    await runtime.onPtyExit('pty-c', 0)
    db.bindRun({ runId, coordinatorHandle: 'term_n', coordinatorPaneKey: `tab_n:${LEAF}` })
    expect(getQuestionTaker(db, ask())).toBeNull()
  })
})
