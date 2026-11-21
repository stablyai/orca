import { describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import { formatOrcaSessionAddress } from '../../../../../shared/agent-session/identity/orca-session-address'
import { testOrcaSessionId } from '../../../../../shared/agent-session/identity/orca-session-address-test-fixture'
import { OrchestrationDb } from '../../db/orchestration-db'
import '../../db/contract-constants'
import '../../db/messages/mailbox-routing-page'
import '../../db/dispatch-row-writer'
import '../../db/attempt-outcome-projection'
import { createRootDispatch } from '../../db/root-dispatch-test-fixture'
import { TerminalWorkerTurnStops } from './terminal-worker-turn-stops'
import {
  reportDismissedCutWorkers,
  reportWorkerStopsAcrossRestart
} from './restart-worker-stop-report'
import { chatWorkerDispatches } from './chat-worker-error-escalation'
import { observeWorker } from './worker-presence-report'
import type {
  StructuredAgentSessionRestartCut,
  StructuredAgentSessionRestartResume
} from '../../../../native-chat/agent-session-wire/recovery/structured-agent-session-restart-resume-contract'

const PANE = makePaneKey('tab-worker', '11111111-1111-4111-8111-111111111111')
const HANDLE = 'term_worker'
const CHAT_SESSION = testOrcaSessionId('9a4e7c1b-3d2f-4b6a-8e5c-7f1d0b2a6c93')

function setup(assignee: string) {
  const db = new OrchestrationDb(':memory:')
  const run = db.createRun({
    objective: 'restart reports',
    coordinatorHandle: 'term_coordinator',
    coordinatorPaneKey: makePaneKey('tab-coordinator', '22222222-2222-4222-8222-222222222222')
  })
  const task = db.createTask({ spec: 'do the work', runId: run.id })
  createRootDispatch(db, task.id, assignee, assignee === HANDLE ? PANE : undefined)
  const reportDeps = { getDb: () => db, isWaitingForMail: () => false, notify: vi.fn() }
  const mail = () => db.getUnreadRunMailbox(run.id, 100, ['escalation'])
  return { db, run, reportDeps, mail }
}

function restingTerminal(ctx: ReturnType<typeof setup>, state: AgentStatusIpcPayload['state']) {
  const row: AgentStatusIpcPayload = {
    state,
    prompt: '',
    agentType: 'claude',
    paneKey: PANE,
    connectionId: null,
    receivedAt: 1,
    stateStartedAt: 200,
    lastAssistantMessage: 'Sent worker_done, but Orca did not answer.'
  }
  return new TerminalWorkerTurnStops({
    ...ctx.reportDeps,
    readHookRow: () => row,
    setTimer: (run) => {
      queueMicrotask(run)
      return { cancel: () => {} }
    },
    getHandle: () => HANDLE,
    getProcessIncarnation: () => null,
    takeOpenApproval: async () => null,
    markApprovalReported: () => {},
    readScreen: async () => ({
      handle: HANDLE,
      status: 'running',
      tail: [],
      truncated: false,
      nextCursor: null
    })
  })
}

describe('worker stops across a restart', () => {
  it('reports a terminal worker whose turn ended while Orca was down, once', async () => {
    const ctx = setup(HANDLE)
    const stops = restingTerminal(ctx, 'done')
    const pass = () =>
      reportWorkerStopsAcrossRestart({
        db: ctx.db,
        reportDeps: ctx.reportDeps,
        reportRestingPane: (paneKey) => stops.reportRestingPane(paneKey),
        reportUnconfirmedStart: async () => {},
        chats: null
      })
    await pass()
    await pass()
    const reports = ctx.mail()
    expect(reports.map((report) => report.subject)).toEqual(['Worker stopped without reporting'])
    expect(reports[0]?.body).toContain('Sent worker_done, but Orca did not answer.')
  })

  it('leaves a terminal worker that is still working', async () => {
    const ctx = setup(HANDLE)
    const stops = restingTerminal(ctx, 'working')
    await reportWorkerStopsAcrossRestart({
      db: ctx.db,
      reportDeps: ctx.reportDeps,
      reportRestingPane: (paneKey) => stops.reportRestingPane(paneKey),
      reportUnconfirmedStart: async () => {},
      chats: null
    })
    expect(ctx.mail()).toEqual([])
  })

  it('decides every start left undecided, and no other worker', async () => {
    const ctx = setup(HANDLE)
    const startUnknown = (spec: string) => {
      const task = ctx.db.createTask({ spec, runId: ctx.run.id })
      const started = ctx.db.createStartingWorkerDispatch({
        creator: { kind: 'system' },
        maxDepth: Number.MAX_SAFE_INTEGER,
        taskId: task.id,
        startOptions: {}
      })
      return started.dispatch.id
    }
    const cut = startUnknown('cut by the restart')
    const unseen = startUnknown('turn never seen')
    ctx.db.markWorkerStartUnknown(unseen, 'turn_start_unobserved', 'not seen')
    const decided: string[] = []
    await reportWorkerStopsAcrossRestart({
      db: ctx.db,
      reportDeps: ctx.reportDeps,
      reportRestingPane: async () => {},
      reportUnconfirmedStart: async (dispatchId) => void decided.push(dispatchId),
      chats: null
    })
    expect(decided.sort()).toEqual([cut, unseen].sort())
  })

  const chatPass = (
    ctx: ReturnType<typeof setup>,
    cut: Awaited<ReturnType<StructuredAgentSessionRestartResume['cutOf']>>,
    open: () => Promise<unknown> = async () => undefined,
    cutByLastRun: ReadonlySet<string> = new Set([CHAT_SESSION]),
    lineageRoot: (sessionId: string) => string = (sessionId) => sessionId,
    offered: ReadonlyMap<string, StructuredAgentSessionRestartCut> = new Map()
  ) =>
    reportWorkerStopsAcrossRestart({
      db: ctx.db,
      reportDeps: ctx.reportDeps,
      reportRestingPane: async () => {},
      reportUnconfirmedStart: async () => {},
      chats: {
        cutByLastRun,
        lineageRoot,
        offeredCuts: async () => offered,
        open,
        lastOutput: () => 'Running the migration.',
        cutOf: async () => cut
      }
    })

  it('opens no chat worker the run that just ended did not cut, even one an older run cut', async () => {
    const ctx = setup(formatOrcaSessionAddress(CHAT_SESSION))
    const open = vi.fn(async () => undefined)
    await chatPass(ctx, { cause: 'quit', turnId: 'turn-0' }, open, new Set())
    expect(open).not.toHaveBeenCalled()
    expect(ctx.mail()).toEqual([])
  })

  it('reports each cut of a chat worker once, never one not cut', async () => {
    const ctx = setup(formatOrcaSessionAddress(CHAT_SESSION))
    await chatPass(ctx, null)
    expect(ctx.mail()).toEqual([])
    await chatPass(ctx, { cause: 'crash', turnId: 'turn-1' })
    await chatPass(ctx, { cause: 'crash', turnId: 'turn-1' })
    const reports = ctx.mail()
    expect(reports.map((report) => report.subject)).toEqual(['Worker exited without reporting'])
    expect(reports[0]?.body).toContain('Orca crashed during its turn')
    expect(reports[0]?.body).toContain('A message restarts it')
    // Mail continued it, and a later crash cut its next turn.
    await chatPass(ctx, { cause: 'crash', turnId: 'turn-2' })
    expect(ctx.mail()).toHaveLength(2)
  })

  it('reports a chat cut while asking its person as waiting, also after its live report said to wait for an answer', async () => {
    const asking = {
      cause: 'quit',
      turnId: 'turn-1',
      waitingOnPerson: true
    } as const
    const fresh = setup(formatOrcaSessionAddress(CHAT_SESSION))
    await chatPass(fresh, asking)
    expect(fresh.mail().map((report) => report.subject)).toEqual(['Worker is waiting on a prompt'])

    const reported = setup(formatOrcaSessionAddress(CHAT_SESSION))
    const [worker] = chatWorkerDispatches(CHAT_SESSION, reported.db)
    // What the live path sent before Orca stopped: the same prompt, by its item id.
    observeWorker(
      reported.db,
      { kind: 'local', dispatch: worker!.dispatch },
      {
        presence: 'at-rest',
        fence: 'prompt:ask-1',
        legacyStopKey: 'prompt:ask-1',
        rest: { from: worker!.from, reason: 'needs-input', lastOutput: undefined }
      },
      reported.reportDeps
    )
    await chatPass(reported, asking)
    await chatPass(reported, asking)
    expect(reported.mail().map((report) => report.subject)).toEqual([
      'Worker is waiting on a prompt',
      'Worker is waiting on a prompt'
    ])
  })

  it('tells the coordinator once when a person dismisses a cut worker, also after a startup report of that cut', async () => {
    const ctx = setup(formatOrcaSessionAddress(CHAT_SESSION))
    const dismiss = () =>
      reportDismissedCutWorkers(
        { db: ctx.db, reportDeps: ctx.reportDeps, lastOutput: () => 'Running the migration.' },
        [{ sessionId: CHAT_SESSION, cut: { cause: 'crash', turnId: 'turn-1' } }]
      )
    dismiss()
    dismiss()
    const reports = ctx.mail()
    expect(reports.map((report) => report.subject)).toEqual(['Worker exited without reporting'])
    expect(reports[0]?.body).toContain('its restart offer was dismissed')
    await chatPass(ctx, { cause: 'crash', turnId: 'turn-1' })
    expect(ctx.mail()).toHaveLength(1)
  })

  it('leaves a Dispatch whose brief has not reached its worker yet', async () => {
    const ctx = setup(formatOrcaSessionAddress(CHAT_SESSION))
    ctx.db.getWorkerDispatch = () =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the pass reads only the state.
      ({ state: 'starting' }) as ReturnType<typeof ctx.db.getWorkerDispatch>
    await chatPass(ctx, { cause: 'crash', turnId: 'turn-1' })
    expect(ctx.mail()).toEqual([])
  })

  it('reports a cut in the /clear successor of the chat its Dispatch names', async () => {
    const ctx = setup(formatOrcaSessionAddress(CHAT_SESSION))
    const successor = testOrcaSessionId('5b2c8d1e-7a4f-4c3b-9d6e-1f0a2b3c4d5e')
    await chatPass(
      ctx,
      { cause: 'crash', turnId: 'turn-1' },
      undefined,
      new Set([successor]),
      (s) => (s === successor ? CHAT_SESSION : s)
    )
    expect(ctx.mail().map((report) => report.subject)).toEqual(['Worker exited without reporting'])
  })

  it("visits a paired server's worker, which has only its attachment here", async () => {
    const db = new OrchestrationDb(':memory:')
    db.createRemoteDispatchAttachment({
      runId: 'run-home',
      dispatchId: 'ctx_remote',
      taskId: 'task_remote',
      homePeerFingerprint: 'home_peer',
      protocolVersion: 1,
      runtimeEpoch: 'worker_epoch',
      mutationReceipt: {
        callerFingerprint: 'home_peer',
        requestId: 'attach_remote',
        method: 'orchestration.federationAttachStart',
        payloadHash: 'attach_hash'
      }
    })
    db.db.prepare("UPDATE remote_dispatch_attachments SET state = 'ready', pane_key = ?").run(PANE)
    const visited: string[] = []
    await reportWorkerStopsAcrossRestart({
      db,
      reportDeps: { getDb: () => db, isWaitingForMail: () => false, notify: vi.fn() },
      reportRestingPane: async (paneKey) => void visited.push(paneKey),
      reportUnconfirmedStart: async () => {},
      chats: null
    })
    expect(visited).toEqual([PANE])
  })

  it('decides again a rest a wait for mail held back, since no wait outlives a restart', async () => {
    const ctx = setup(formatOrcaSessionAddress(CHAT_SESSION))
    const [worker] = chatWorkerDispatches(CHAT_SESSION, ctx.db)
    observeWorker(
      ctx.db,
      { kind: 'local', dispatch: worker!.dispatch },
      {
        presence: 'at-rest',
        fence: 'turn:turn-1',
        legacyStopKey: 'turn:turn-1',
        rest: { from: worker!.from, reason: 'needs-input', lastOutput: undefined }
      },
      { ...ctx.reportDeps, isWaitingForMail: () => true }
    )
    expect(ctx.mail()).toEqual([])
    await chatPass(ctx, null, undefined, new Set())
    expect(ctx.mail().map((report) => report.subject)).toEqual(['Worker is waiting on a prompt'])
  })

  it("visits every resting terminal without waiting on another pane's screen", async () => {
    const ctx = setup(HANDLE)
    const other = makePaneKey('tab-other', '33333333-3333-4333-8333-333333333333')
    const task = ctx.db.createTask({ spec: 'more work', runId: ctx.run.id })
    createRootDispatch(ctx.db, task.id, 'term_other', other)
    const visited: string[] = []
    void reportWorkerStopsAcrossRestart({
      db: ctx.db,
      reportDeps: ctx.reportDeps,
      // The first pane's screen never answers.
      reportRestingPane: (paneKey) => {
        visited.push(paneKey)
        return new Promise(() => {})
      },
      reportUnconfirmedStart: async () => {},
      chats: null
    })
    await vi.waitFor(() => expect(visited.sort()).toEqual([PANE, other].sort()))
  })

  it('does not tell a coordinator that a worker a crash may have left running exited', async () => {
    const ctx = setup(formatOrcaSessionAddress(CHAT_SESSION))
    await chatPass(ctx, { cause: 'crash', turnId: 'turn-1', exitUnproven: true })
    const [report] = ctx.mail()
    expect(report?.subject).toBe('Worker lost without reporting')
    expect(report?.body).toContain('its agent may still be running')
    expect(report?.body).not.toContain('A message restarts it')
  })

  it('does not tell a coordinator that a dismissed worker whose continuation was never confirmed exited', () => {
    const ctx = setup(formatOrcaSessionAddress(CHAT_SESSION))
    reportDismissedCutWorkers(
      { db: ctx.db, reportDeps: ctx.reportDeps, lastOutput: () => undefined },
      [
        {
          sessionId: CHAT_SESSION,
          cut: { cause: 'quit', turnId: 'turn-1', continuationUnconfirmed: true }
        }
      ]
    )
    const [report] = ctx.mail()
    expect(report?.subject).toBe('Worker lost without reporting')
    expect(report?.body).toContain('never saw it start, and its restart offer was dismissed')
    expect(report?.body).not.toContain('A message restarts it')
  })

  it('keeps a rest held back by a wait silent while its chat still waits on a restart decision', async () => {
    const ctx = setup(formatOrcaSessionAddress(CHAT_SESSION))
    const [worker] = chatWorkerDispatches(CHAT_SESSION, ctx.db)
    observeWorker(
      ctx.db,
      { kind: 'local', dispatch: worker!.dispatch },
      {
        presence: 'at-rest',
        fence: 'prompt:ask-1',
        legacyStopKey: 'prompt:ask-1',
        rest: { from: worker!.from, reason: 'needs-input', lastOutput: undefined }
      },
      { ...ctx.reportDeps, isWaitingForMail: () => true }
    )
    // The setting is off: nothing was cut by this start's own action, and the offer waits.
    await chatPass(
      ctx,
      null,
      undefined,
      new Set(),
      undefined,
      new Map([[CHAT_SESSION, { cause: 'crash', turnId: 'turn-1', waitingOnPerson: true }]])
    )
    expect(ctx.mail()).toEqual([])
  })

  it.each(['stopping', 'stop_unknown'] as const)(
    'does not report a terminal worker whose stop its coordinator asked for (%s)',
    async (state) => {
      const ctx = setup(HANDLE)
      ctx.db.getWorkerDispatch = () =>
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the pass reads only the state.
        ({ state }) as ReturnType<typeof ctx.db.getWorkerDispatch>
      const stops = restingTerminal(ctx, 'done')
      await reportWorkerStopsAcrossRestart({
        db: ctx.db,
        reportDeps: ctx.reportDeps,
        reportRestingPane: (paneKey) => stops.reportRestingPane(paneKey),
        reportUnconfirmedStart: async () => {},
        chats: null
      })
      expect(ctx.mail()).toEqual([])
    }
  )

  it("does not visit a paired server's worker its coordinator is stopping", async () => {
    const db = new OrchestrationDb(':memory:')
    db.createRemoteDispatchAttachment({
      runId: 'run-home',
      dispatchId: 'ctx_remote',
      taskId: 'task_remote',
      homePeerFingerprint: 'home_peer',
      protocolVersion: 1,
      runtimeEpoch: 'worker_epoch',
      mutationReceipt: {
        callerFingerprint: 'home_peer',
        requestId: 'attach_remote',
        method: 'orchestration.federationAttachStart',
        payloadHash: 'attach_hash'
      }
    })
    db.db
      .prepare("UPDATE remote_dispatch_attachments SET state = 'stop_unknown', pane_key = ?")
      .run(PANE)
    const visited: string[] = []
    await reportWorkerStopsAcrossRestart({
      db,
      reportDeps: { getDb: () => db, isWaitingForMail: () => false, notify: vi.fn() },
      reportRestingPane: async (paneKey) => void visited.push(paneKey),
      reportUnconfirmedStart: async () => {},
      chats: null
    })
    expect(visited).toEqual([])
  })

  it("decides again another worker's held-back rest while one pane's screen read hangs", async () => {
    const ctx = setup(HANDLE)
    const task = ctx.db.createTask({ spec: 'chat work', runId: ctx.run.id })
    const chat = createRootDispatch(ctx.db, task.id, formatOrcaSessionAddress(CHAT_SESSION))
    observeWorker(
      ctx.db,
      { kind: 'local', dispatch: chat },
      {
        presence: 'at-rest',
        fence: 'turn:turn-1',
        legacyStopKey: 'turn:turn-1',
        rest: { from: 'chat', reason: 'needs-input', lastOutput: undefined }
      },
      { ...ctx.reportDeps, isWaitingForMail: () => true }
    )
    void reportWorkerStopsAcrossRestart({
      db: ctx.db,
      reportDeps: ctx.reportDeps,
      reportRestingPane: () => new Promise(() => {}),
      reportUnconfirmedStart: async () => {},
      chats: null
    })
    await vi.waitFor(() => expect(ctx.mail()).toHaveLength(1))
  })

  it('drops a cut once its worker has started and rested again since the offers were read', async () => {
    const ctx = setup(formatOrcaSessionAddress(CHAT_SESSION))
    const [worker] = chatWorkerDispatches(CHAT_SESSION, ctx.db)
    const target = { kind: 'local' as const, dispatch: worker!.dispatch }
    await chatPass(ctx, { cause: 'crash', turnId: 'turn-0' }, async () => {
      observeWorker(ctx.db, target, { presence: 'working', newTurn: true }, ctx.reportDeps)
      observeWorker(
        ctx.db,
        target,
        {
          presence: 'at-rest',
          fence: 'turn:turn-1',
          legacyStopKey: 'turn:turn-1',
          rest: { from: worker!.from, reason: 'needs-input', lastOutput: undefined }
        },
        ctx.reportDeps
      )
    })
    expect(ctx.mail().map((report) => report.subject)).toEqual(['Worker is waiting on a prompt'])
  })

  it('keeps a held-back rest silent at startup while its coordinator stops the worker', async () => {
    const ctx = setup(formatOrcaSessionAddress(CHAT_SESSION))
    const [worker] = chatWorkerDispatches(CHAT_SESSION, ctx.db)
    observeWorker(
      ctx.db,
      { kind: 'local', dispatch: worker!.dispatch },
      {
        presence: 'at-rest',
        fence: 'turn:turn-1',
        legacyStopKey: 'turn:turn-1',
        rest: { from: worker!.from, reason: 'needs-input', lastOutput: undefined }
      },
      { ...ctx.reportDeps, isWaitingForMail: () => true }
    )
    ctx.db.getWorkerDispatch = () =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the pass reads only the state.
      ({ state: 'stopping' }) as ReturnType<typeof ctx.db.getWorkerDispatch>
    await chatPass(ctx, null, undefined, new Set())
    expect(ctx.mail()).toEqual([])
  })

  it('still visits resting terminals when the restart offers cannot be read', async () => {
    const ctx = setup(HANDLE)
    const visited: string[] = []
    await reportWorkerStopsAcrossRestart({
      db: ctx.db,
      reportDeps: ctx.reportDeps,
      reportRestingPane: async (paneKey) => void visited.push(paneKey),
      reportUnconfirmedStart: async () => {},
      chats: {
        cutByLastRun: new Set(),
        lineageRoot: (sessionId) => sessionId,
        offeredCuts: () => Promise.reject(new Error('capsule unreadable')),
        open: async () => undefined,
        lastOutput: () => undefined,
        cutOf: async () => null
      }
    })
    expect(visited).toEqual([PANE])
  })

  it('drops a cut whose continuation a person started while the offers were being read', async () => {
    const ctx = setup(formatOrcaSessionAddress(CHAT_SESSION))
    const [worker] = chatWorkerDispatches(CHAT_SESSION, ctx.db)
    const cut = { cause: 'quit', turnId: 'turn-0' } as const
    await reportWorkerStopsAcrossRestart({
      db: ctx.db,
      reportDeps: ctx.reportDeps,
      reportRestingPane: async () => {},
      reportUnconfirmedStart: async () => {},
      chats: {
        cutByLastRun: new Set([CHAT_SESSION]),
        lineageRoot: (sessionId) => sessionId,
        offeredCuts: async () => {
          observeWorker(
            ctx.db,
            { kind: 'local', dispatch: worker!.dispatch },
            { presence: 'working', newTurn: true },
            ctx.reportDeps
          )
          return new Map([[CHAT_SESSION, cut]])
        },
        open: async () => undefined,
        lastOutput: () => undefined,
        cutOf: async () => cut
      }
    })
    expect(ctx.mail()).toEqual([])
  })
})
