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

  it('reports a chat worker left at rest, and not one Orca continued', async () => {
    for (const [status, reports] of [
      ['idle', ['Worker stopped without reporting']],
      ['working', []]
    ] as const) {
      const ctx = setup(formatOrcaSessionAddress(CHAT_SESSION))
      const open = vi.fn(async () => undefined)
      await reportWorkerStopsAcrossRestart({
        db: ctx.db,
        reportDeps: ctx.reportDeps,
        reportRestingPane: async () => {},
        chats: { open, status: async () => ({ status, lastAssistantMessage: 'Waiting.' }) }
      })
      expect(open).toHaveBeenCalledWith(CHAT_SESSION)
      expect(ctx.mail().map((report) => report.subject)).toEqual(reports)
    }
  })
})
