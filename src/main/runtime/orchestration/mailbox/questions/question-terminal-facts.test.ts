import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../../db/orchestration-db'
import '../../db/contract-constants'
import '../../db/messages/mailbox-routing-page'
import '../../db/dispatch-row-writer'
import { reconcileQuestions } from './question-reconcile'
import { readQuestionPartyFacts, type QuestionPartyReads } from './question-party-facts'
import { QuestionReconciler } from './question-reconciler'
import { installQuestionReconciler } from './question-reconciler-install'
import type { AgentPaneChange } from '../../../../agent-hooks/observations/agent-transition-detector'
import { noteQuestionEdge } from '../../db/messages/question-edges'

const HANDLE = 'term_coordinator'
const TAKER = `terminal:${HANDLE}`

describe("a terminal taker's pending wake", () => {
  let db: OrchestrationDb
  let takesInput: boolean

  const reads: QuestionPartyReads = {
    liveSession: (root) => root,
    chatRunning: async () => false,
    chatReceiving: () => null,
    chatHandingOver: () => false,
    terminal: (handle) =>
      handle === HANDLE
        ? { ptyId: 'pty-1', paneKeys: [], asking: false, takesInput, working: false }
        : null,
    terminalHandingOver: () => false
  }

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    takesInput = true
  })
  afterEach(() => db.close())

  function takenQuestion(): string {
    const admitted = db.admitBotRequest({
      rootKey: 'a',
      fromBotId: 'ranger',
      toBotId: 'docs',
      purpose: 'question',
      depth: 1,
      record: '{}',
      message: { from: 'orca_session_id:asker', to: HANDLE, subject: 'q', type: 'question' }
    })
    const id = admitted.kind === 'sent' ? admitted.message.id : ''
    db.markAsRead([id], { kind: 'terminal', handle: HANDLE })
    return id
  }

  async function told(): Promise<string[]> {
    const facts = await readQuestionPartyFacts(db, reads, [TAKER])
    return reconcileQuestions(
      db,
      facts,
      (notice) => {
        db.recordBotRequestOutcome(notice.messageId, 'unanswered')
        return 'told'
      },
      TAKER
    ).map((notice) => notice.messageId)
  }

  it('holds the question while mail waits to be typed into the agent', async () => {
    takenQuestion()
    db.insertMessage({ from: 'term_worker', to: HANDLE, subject: 'status', body: 'b' })
    expect(await told()).toEqual([])
  })

  it('tells the asker when the agent exited to its shell, since that mail is never typed', async () => {
    const id = takenQuestion()
    db.insertMessage({ from: 'term_worker', to: HANDLE, subject: 'status', body: 'b' })
    takesInput = false
    expect(await told()).toEqual([id])
  })
})

describe('a terminal coordinator with no agent in it (#49550)', () => {
  const PANE = 'tab-1:11111111-1111-4111-8111-111111111111'
  let db: OrchestrationDb
  let live: boolean
  let working: boolean
  let agentTakesInput: boolean
  let chatRead: Promise<void>
  let told: string[]
  let reconciler: QuestionReconciler
  let stop: () => void

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    live = true
    working = false
    agentTakesInput = false
    chatRead = Promise.resolve()
    told = []
    reconciler = new QuestionReconciler(db, {
      reads: {
        liveSession: (root) => root,
        chatRunning: async () => {
          await chatRead
          return false
        },
        chatReceiving: () => null,
        chatHandingOver: () => false,
        terminal: (handle) =>
          handle === HANDLE && live
            ? {
                ptyId: 'pty-1',
                paneKeys: [PANE],
                asking: false,
                takesInput: agentTakesInput,
                working
              }
            : null,
        terminalHandingOver: () => false
      },
      notices: async () => (notice) => {
        db.recordBotRequestOutcome(notice.messageId, 'unanswered')
        told.push(notice.messageId)
        return 'told'
      },
      sessionParty: (sessionId) => `session:${sessionId}`,
      terminalParty: () => TAKER
    })
    stop = reconciler.start()
  })
  afterEach(() => {
    stop()
    db.close()
  })

  function coordinate(): string {
    return db.createRun({
      objective: 'o',
      coordinatorHandle: HANDLE,
      coordinatorPaneKey: PANE,
      coordinatorOrcaSessionId: null
    }).id
  }

  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await reconciler.settled()
  }

  function ask(): string {
    const admitted = db.admitBotRequest({
      rootKey: 'a',
      fromBotId: 'ranger',
      toBotId: 'docs',
      purpose: 'question',
      depth: 1,
      record: '{}',
      message: { from: 'orca_session_id:asker', to: HANDLE, subject: 'q', type: 'question' }
    })
    return admitted.kind === 'sent' ? admitted.message.id : ''
  }

  async function take(id = ask()): Promise<string> {
    db.markAsRead([id], { kind: 'terminal', handle: HANDLE })
    await settle()
    return id
  }

  it('holds a question while its pty lives, and tells once that pty ends or is replaced', async () => {
    coordinate()
    const id = await take()
    expect(told).toEqual([])
    noteQuestionEdge({ kind: 'exit', ptyId: 'pty-other' })
    await settle()
    expect(told).toEqual([])
    // Exit and in-place replacement both end by pty id, whatever handle the take came under.
    noteQuestionEdge({ kind: 'exit', ptyId: 'pty-1' })
    await settle()
    expect(told).toEqual([id])
  })

  it('tells once it no longer coordinates the Run, though its terminal stays open', async () => {
    coordinate()
    const id = await take()
    expect(told).toEqual([])
    db.unbindOtherRunsForCoordinator(
      { terminalHandle: HANDLE, paneKey: PANE, orcaSessionId: null },
      'run_none'
    )
    await settle()
    expect(told).toEqual([id])
  })

  it('tells once the Dispatch it works settles, though its terminal stays open', async () => {
    const task = db.createTask({ runId: coordinate(), spec: 'work' })
    db.unbindOtherRunsForCoordinator(
      { terminalHandle: HANDLE, paneKey: PANE, orcaSessionId: null },
      'run_none'
    )
    const dispatch = db.createDispatchContext({
      taskId: task.id,
      assigneeHandle: HANDLE,
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER
    })
    const id = await take()
    expect(told).toEqual([])
    db.completeDispatch(dispatch.id)
    await settle()
    expect(told).toEqual([id])
  })

  it('judges by the agent once one takes input there, even one never seen working', async () => {
    coordinate()
    const id = await take()
    agentTakesInput = true
    db.insertMessage({ from: 'term_worker', to: HANDLE, subject: 'status', body: 'b' })
    noteQuestionEdge({ kind: 'pane', ptyId: 'pty-1' })
    await settle()
    expect(told).toEqual([])
    agentTakesInput = false
    noteQuestionEdge({ kind: 'pane', ptyId: 'pty-1' })
    await settle()
    expect(told).toEqual([id])
  })

  it('does not tell on a binding read before a Run bound to it mid-decision', async () => {
    const id = ask()
    // A worker started for the question, whose chat the decision awaits after reading the terminal.
    const task = db.createTask({ runId: coordinate(), spec: 'work' })
    db.unbindOtherRunsForCoordinator(
      { terminalHandle: HANDLE, paneKey: PANE, orcaSessionId: null },
      'run_none'
    )
    const linked = db.createDispatchContext({
      taskId: task.id,
      assigneeHandle: 'term_worker',
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER
    })
    db.db
      .prepare(
        `UPDATE dispatch_contexts SET for_message_id = ?, assignee_handle = NULL,
           assignee_orca_session_id = 'worker-chat' WHERE id = ?`
      )
      .run(id, linked.id)
    let release = (): void => undefined
    chatRead = new Promise((resolve) => (release = resolve))
    db.markAsRead([id], { kind: 'terminal', handle: HANDLE })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const runId = coordinate()
    noteQuestionEdge({ kind: 'mailbox', mailbox: `run:${runId}` })
    await new Promise((resolve) => setTimeout(resolve, 0))
    chatRead = Promise.resolve()
    release()
    await settle()
    expect(told).toEqual([])
  })

  it('does not tell on a terminal read before an agent-less take committed mid-decision', async () => {
    coordinate()
    // An agent took a first question, with a worker started for it whose chat the decision awaits.
    working = true
    const first = ask()
    const task = db.createTask({ runId: coordinate(), spec: 'work' })
    const linked = db.createDispatchContext({
      taskId: task.id,
      assigneeHandle: 'term_worker',
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER
    })
    db.db
      .prepare(
        `UPDATE dispatch_contexts SET for_message_id = ?, assignee_handle = NULL,
           assignee_orca_session_id = 'worker-chat' WHERE id = ?`
      )
      .run(first, linked.id)
    await take(first)
    // The agent stops; while that decision awaits the worker's chat, the shell takes another.
    working = false
    let release = (): void => undefined
    chatRead = new Promise((resolve) => (release = resolve))
    reconciler.terminalChanged(TAKER, false)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const second = ask()
    db.markAsRead([second], { kind: 'terminal', handle: HANDLE })
    await new Promise((resolve) => setTimeout(resolve, 0))
    chatRead = Promise.resolve()
    release()
    await settle()
    expect(told).toEqual([])
  })

  it('still tells when an agent coordinator stops at its shell', async () => {
    coordinate()
    working = true
    const id = await take()
    expect(told).toEqual([])
    working = false
    reconciler.terminalChanged(TAKER, false)
    await settle()
    expect(told).toEqual([id])
  })
})

describe('an agent seen in an agent-less terminal before its take is first decided', () => {
  it('clears the agent-less hold, so that agent stopping tells', async () => {
    const PANE = 'tab-1:22222222-2222-4222-8222-222222222222'
    const db = new OrchestrationDb(':memory:')
    const told: string[] = []
    let panes: (change: AgentPaneChange) => void = () => undefined
    let release = (): void => undefined
    const firstNotices = new Promise<void>((resolve) => (release = resolve))
    db.createRun({
      objective: 'o',
      coordinatorHandle: HANDLE,
      coordinatorPaneKey: PANE,
      coordinatorOrcaSessionId: null
    })
    const { reconciler, stop } = installQuestionReconciler(db, {
      reads: {
        liveSession: (root) => root,
        chatReceiving: () => null,
        chatHandingOver: () => false,
        terminal: (handle) =>
          handle === HANDLE
            ? { ptyId: 'pty-1', paneKeys: [PANE], asking: false, takesInput: false, working: false }
            : null,
        terminalHandingOver: () => false
      },
      notices: async () => {
        await firstNotices
        return (notice) => {
          db.recordBotRequestOutcome(notice.messageId, 'unanswered')
          told.push(notice.messageId)
          return 'told'
        }
      },
      sessionParty: (sessionId) => `session:${sessionId}`,
      terminalOfPty: () => HANDLE,
      terminalOfPane: () => HANDLE,
      subscribePanes: (listener) => {
        panes = listener
        return () => undefined
      }
    })
    try {
      const admitted = db.admitBotRequest({
        rootKey: 'a',
        fromBotId: 'ranger',
        toBotId: 'docs',
        purpose: 'question',
        depth: 1,
        record: '{}',
        message: { from: 'orca_session_id:asker', to: HANDLE, subject: 'q', type: 'question' }
      })
      const id = admitted.kind === 'sent' ? admitted.message.id : ''
      db.markAsRead([id], { kind: 'terminal', handle: HANDLE })
      await new Promise((resolve) => setTimeout(resolve, 0))
      // An agent starts and stops there while the first decision waits.
      panes({ kind: 'observed', paneKey: PANE, workspace: null, phase: 'done', at: 1 })
      panes({ kind: 'observed', paneKey: PANE, workspace: null, phase: 'rest', at: 2 })
      release()
      await new Promise((resolve) => setTimeout(resolve, 0))
      await reconciler.settled()
      expect(told).toEqual([id])
    } finally {
      stop()
      db.close()
    }
  })
})
