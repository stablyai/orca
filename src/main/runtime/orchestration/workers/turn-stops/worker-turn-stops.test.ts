import { describe, expect, it, vi } from 'vitest'
import type { AgentPaneChange } from '../../../../agent-hooks/observations/agent-transition-detector'
import type { AgentStatusIpcPayload } from '../../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { AgentSessionTurnCompletionEvent } from '../../../../../shared/agent-session/view/agent-session-turn-completion-wire'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host'
import { formatOrcaSessionAddress } from '../../../../../shared/orca-session-address'
import { testOrcaSessionId } from '../../../../../shared/orca-session-address-test-fixture'
import { chatWorkerTurnStopReporter } from './chat-worker-turn-stops'
import { OrchestrationDb } from '../../db/orchestration-db'
import '../../db/contract-constants'
import '../../db/messages/mailbox-routing-page'
import '../../db/dispatch-row-writer'
import '../../db/attempt-outcome-projection'
import { createRootDispatch } from '../../db/root-dispatch-test-fixture'
import { TerminalWorkerTurnStops } from './terminal-worker-turn-stops'

const PANE = makePaneKey('tab-worker', '11111111-1111-4111-8111-111111111111')
const HANDLE = 'term_worker'

const CHAT_SESSION = testOrcaSessionId('9a4e7c1b-3d2f-4b6a-8e5c-7f1d0b2a6c93')

function setup(assignee = HANDLE) {
  const db = new OrchestrationDb(':memory:')
  const run = db.createRun({
    objective: 'stop reports',
    coordinatorHandle: 'term_coordinator',
    coordinatorPaneKey: makePaneKey('tab-coordinator', '22222222-2222-4222-8222-222222222222')
  })
  const task = db.createTask({ spec: 'do the work', runId: run.id })
  const dispatch = createRootDispatch(db, task.id, assignee, assignee === HANDLE ? PANE : undefined)
  const waiting = new Set<string>()
  const notify = vi.fn()
  const deps = {
    getDb: (): OrchestrationDb | null => db,
    isWaitingForMail: (m: string) => waiting.has(m),
    notify
  }
  const mail = () => db.getUnreadRunMailbox(run.id, 100, ['escalation'])
  return { db, run, dispatch, waiting, notify, deps, mail }
}

function hookRow(overrides: Partial<AgentStatusIpcPayload>): AgentStatusIpcPayload {
  return {
    state: 'done',
    prompt: '',
    agentType: 'codex',
    paneKey: PANE,
    connectionId: null,
    receivedAt: 1,
    stateStartedAt: 200,
    ...overrides
  }
}

function moved(from: 'working' | 'done', to: 'done' | 'needs-you'): AgentPaneChange {
  return {
    kind: 'moved',
    paneKey: PANE,
    workspace: { worktreeId: 'repo::/tmp/wt', sshHostId: null },
    from,
    to,
    at: 1,
    transition: to === 'needs-you' ? 'needs-input' : 'turn-finished'
  }
}

function terminal(ctx: ReturnType<typeof setup>, current: { row: AgentStatusIpcPayload }) {
  return new TerminalWorkerTurnStops({
    ...ctx.deps,
    readHookRow: () => current.row,
    setTimer: (run) => {
      queueMicrotask(run)
      return { cancel: () => {} }
    },
    getHandle: () => HANDLE,
    getProcessIncarnation: () => null,
    takeOpenApproval: () => null,
    readScreen: async () => ({
      handle: HANDLE,
      status: 'running',
      tail: ['■ Selected model is at capacity. Please try a different model.'],
      truncated: false,
      nextCursor: null
    })
  })
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

describe('terminal worker turn stops', () => {
  it('drops a stop whose Dispatch was replaced before it was reported', async () => {
    const ctx = setup()
    const current = { row: hookRow({ state: 'working' }) }
    const stops = terminal(ctx, current)
    stops.observe({
      kind: 'observed',
      paneKey: PANE,
      workspace: { worktreeId: 'repo::/tmp/wt', sshHostId: null },
      phase: 'working',
      at: 1
    })
    current.row = hookRow({})
    stops.observe(moved('working', 'done'))
    // The quiet window is still open: A settles and the terminal takes follow-up B.
    ctx.db.completeDispatch(ctx.dispatch.id)
    const followUp = ctx.db.createTask({ spec: 'follow up', runId: ctx.run.id })
    createRootDispatch(ctx.db, followUp.id, HANDLE, PANE)
    await settle()
    expect(ctx.mail()).toHaveLength(0)
  })
})

describe('chat worker turn stops', () => {
  const completion = (
    outcome: 'success' | 'failure',
    turnId = 'turn-1'
  ): AgentSessionTurnCompletionEvent => ({
    type: 'completion',
    completion: {
      scope: {
        executionHostId: LOCAL_EXECUTION_HOST_ID,
        wslDistro: null,
        workspaceId: 'repo::/tmp/wt',
        workspaceKind: 'git-worktree'
      },
      sessionId: CHAT_SESSION,
      turnId,
      outcome,
      completedAt: 1
    }
  })

  // The report claimed a follow-up on the same chat; its task is not handed over yet.
  function startingFollowUp(ctx: ReturnType<typeof setup>) {
    const followUp = ctx.db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: 9,
      taskSpec: 'New messages',
      taskRunId: ctx.run.id,
      startOptions: { agent: 'claude' },
      followUpOf: ctx.dispatch.id
    }).dispatch.id
    ctx.db.prepareStartingWorkerAuthority({
      dispatchId: followUp,
      handle: formatOrcaSessionAddress(CHAT_SESSION),
      paneKey: null,
      processIncarnation: null,
      worktreeId: 'repo::/tmp/wt',
      effects: [],
      setupState: 'not_applicable'
    })
    return followUp
  }

  function chatWithTimers(ctx: ReturnType<typeof setup>) {
    const timers: (() => void)[] = []
    const status = 'idle' as const
    const report = chatWorkerTurnStopReporter(ctx.deps, (run) => timers.push(run))
    return {
      finish: (turnId: string) =>
        report(completion('success', turnId), () => ({ status, lastAssistantMessage: 'Done.' })),
      runTimers: () => {
        for (const run of timers.splice(0)) {
          run()
        }
      }
    }
  }

  it('still reports a follow-up whose own turn ended before its start settled', () => {
    const ctx = setup()
    const followUp = startingFollowUp(ctx)
    const chat = chatWithTimers(ctx)

    chat.finish('turn-follow-up')
    chat.runTimers()
    expect(ctx.mail()).toHaveLength(0)
    ctx.db.markWorkerDispatchReady(followUp)
    chat.runTimers()

    expect(ctx.mail()).toMatchObject([
      { subject: 'Worker stopped without reporting', payload: expect.stringContaining(followUp) }
    ])
  })
})
