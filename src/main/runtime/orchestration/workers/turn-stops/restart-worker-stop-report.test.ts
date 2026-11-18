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
import { reportWorkerStopsAcrossRestart } from './restart-worker-stop-report'
import { chatWorkerDispatches } from './chat-worker-error-escalation'
import { reportWorkerTurnStop } from './worker-turn-stop-report'
import type { StructuredAgentSessionRestartResume } from '../../../../native-chat/agent-session-wire/recovery/structured-agent-session-restart-resume-contract'

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
  return { db, reportDeps, mail }
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
      chats: null
    })
    expect(ctx.mail()).toEqual([])
  })

  const chatPass = (
    ctx: ReturnType<typeof setup>,
    status: 'idle' | 'working',
    cut: Awaited<ReturnType<StructuredAgentSessionRestartResume['cutOf']>>,
    open: () => Promise<unknown> = async () => undefined,
    cutByLastRun: ReadonlySet<string> = new Set([CHAT_SESSION])
  ) =>
    reportWorkerStopsAcrossRestart({
      db: ctx.db,
      reportDeps: ctx.reportDeps,
      reportRestingPane: async () => {},
      chats: {
        cutByLastRun,
        open,
        status: async () => ({ status, lastAssistantMessage: 'Running the migration.' }),
        cutOf: async () => cut
      }
    })

  it('opens no chat worker the run that just ended did not cut, even one an older run cut', async () => {
    const ctx = setup(formatOrcaSessionAddress(CHAT_SESSION))
    const open = vi.fn(async () => undefined)
    await chatPass(ctx, 'idle', { cause: 'quit', turnId: 'turn-0' }, open, new Set())
    expect(open).not.toHaveBeenCalled()
    expect(ctx.mail()).toEqual([])
  })

  it('reports each cut of a chat worker once, never one continued or not cut', async () => {
    const ctx = setup(formatOrcaSessionAddress(CHAT_SESSION))
    await chatPass(ctx, 'working', { cause: 'crash', turnId: 'turn-1' })
    await chatPass(ctx, 'idle', null)
    expect(ctx.mail()).toEqual([])
    await chatPass(ctx, 'idle', { cause: 'crash', turnId: 'turn-1' })
    await chatPass(ctx, 'idle', { cause: 'crash', turnId: 'turn-1' })
    const reports = ctx.mail()
    expect(reports.map((report) => report.subject)).toEqual(['Worker exited without reporting'])
    expect(reports[0]?.body).toContain('Orca crashed during its turn')
    expect(reports[0]?.body).toContain('A message restarts it')
    // Mail continued it, and a later crash cut its next turn.
    await chatPass(ctx, 'idle', { cause: 'crash', turnId: 'turn-2' })
    expect(ctx.mail()).toHaveLength(2)
  })

  it('reports a chat cut while asking its person as waiting, also after its live report said to wait for an answer', async () => {
    const asking = {
      cause: 'quit',
      turnId: 'turn-1',
      waitingOnPerson: true
    } as const
    const fresh = setup(formatOrcaSessionAddress(CHAT_SESSION))
    await chatPass(fresh, 'idle', asking)
    expect(fresh.mail().map((report) => report.subject)).toEqual(['Worker is waiting on a prompt'])

    const reported = setup(formatOrcaSessionAddress(CHAT_SESSION))
    const [worker] = chatWorkerDispatches(CHAT_SESSION, reported.db)
    // What the live path sent before Orca stopped: the same prompt, by its item id.
    reportWorkerTurnStop(
      reported.db,
      { kind: 'local', dispatch: worker!.dispatch },
      { from: worker!.from, stopKey: 'prompt:ask-1', reason: 'needs-input', lastOutput: undefined },
      reported.reportDeps
    )
    await chatPass(reported, 'idle', asking)
    await chatPass(reported, 'idle', asking)
    expect(reported.mail().map((report) => report.subject)).toEqual([
      'Worker is waiting on a prompt',
      'Worker is waiting on a prompt'
    ])
  })

  it('leaves a Dispatch whose brief has not reached its worker yet', async () => {
    const ctx = setup(formatOrcaSessionAddress(CHAT_SESSION))
    ctx.db.getWorkerDispatch = () =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the pass reads only the state.
      ({ state: 'starting' }) as ReturnType<typeof ctx.db.getWorkerDispatch>
    await chatPass(ctx, 'idle', { cause: 'crash', turnId: 'turn-1' })
    expect(ctx.mail()).toEqual([])
  })
})
