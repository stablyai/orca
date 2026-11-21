import { describe, expect, it, vi } from 'vitest'
import type { AgentPaneChange } from '../../../../agent-hooks/observations/agent-transition-detector'
import type { AgentStatusIpcPayload } from '../../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { AgentSessionTurnCompletionEvent } from '../../../../../shared/agent-session/view/agent-session-turn-completion-wire'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host/execution-host'
import { formatOrcaSessionAddress } from '../../../../../shared/agent-session/identity/orca-session-address'
import { testOrcaSessionId } from '../../../../../shared/agent-session/identity/orca-session-address-test-fixture'
import { chatWorkerTurnStopReporter } from './chat-worker-turn-stops'
import { OrchestrationDb } from '../../db/orchestration-db'
import '../../db/contract-constants'
import '../../db/messages/mailbox-routing-page'
import '../../db/dispatch-row-writer'
import '../../db/attempt-outcome-projection'
import { createRootDispatch } from '../../db/root-dispatch-test-fixture'
import { TerminalWorkerTurnStops } from './terminal-worker-turn-stops'
import { stopReportId } from './worker-turn-stop-report'
import {
  observeWorker,
  reconsiderCreatorRest,
  reconsiderWorkerRest
} from './worker-presence-report'
import type { WorkerApprovalPayload } from '../../../../../shared/orchestration/approvals/worker-approval-payload'

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

function terminal(
  ctx: ReturnType<typeof setup>,
  current: { row: AgentStatusIpcPayload },
  overrides: Partial<
    Pick<
      ConstructorParameters<typeof TerminalWorkerTurnStops>[0],
      | 'takeOpenApproval'
      | 'markApprovalReported'
      | 'setTimer'
      | 'readScreen'
      | 'getProcessIncarnation'
    >
  > = {}
) {
  return new TerminalWorkerTurnStops({
    ...ctx.deps,
    readHookRow: () => current.row,
    setTimer: (run) => {
      queueMicrotask(run)
      return { cancel: () => {} }
    },
    getHandle: () => HANDLE,
    getProcessIncarnation: () => null,
    takeOpenApproval: async () => null,
    markApprovalReported: () => {},
    readScreen: async () =>
      screen(['■ Selected model is at capacity. Please try a different model.']),
    ...overrides
  })
}

function screen(tail: string[]) {
  return { handle: HANDLE, status: 'running' as const, tail, truncated: false, nextCursor: null }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

/** The coordinator writes to the worker's Dispatch, and the worker takes the mail. */
function writeAndTake(ctx: ReturnType<typeof setup>) {
  const mail = ctx.db.insertMessage({
    from: 'term_coordinator',
    to: `dispatch:${ctx.dispatch.id}`,
    subject: 'Keep going',
    runId: ctx.run.id
  })
  ctx.db.markAsRead([mail.id])
}

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

  it("reports a finish's reply that its transcript read adds within the quiet window", async () => {
    const ctx = setup()
    const current = { row: hookRow({ state: 'working' }) }
    const quiet: (() => void)[] = []
    const stops = terminal(ctx, current, {
      setTimer: (run) => {
        quiet.push(run)
        return { cancel: () => {} }
      }
    })
    stops.observe({
      kind: 'observed',
      paneKey: PANE,
      workspace: { worktreeId: 'repo::/tmp/wt', sshHostId: null },
      phase: 'working',
      at: 1
    })
    current.row = hookRow({})
    stops.observe(moved('working', 'done'))
    current.row = hookRow({ lastAssistantMessage: 'All tests pass.' })
    for (const run of quiet.splice(0)) {
      run()
    }
    await settle()
    expect(ctx.mail().map((m) => m.body)).toEqual([expect.stringContaining('All tests pass.')])
  })

  it('never mails a capability or credential carried in why a worker went away', () => {
    const ctx = setup()
    const capability = 'dcap_0123456789abcdefghijKLMN'
    observeWorker(
      ctx.db,
      { kind: 'local', dispatch: ctx.dispatch },
      {
        presence: 'gone',
        fence: 'start',
        legacyStopKey: 'gone',
        gone: {
          from: HANDLE,
          reason: 'lost',
          lastOutput: undefined,
          cause: `it never started: refused ${capability} at https://user:hunter2@git.example.com/repo`,
          leftover: `workspace ${capability}`
        }
      },
      ctx.deps
    )
    const [mail] = ctx.mail()
    expect(mail?.body).toContain('refused [dispatch capability redacted]')
    expect(mail?.body).not.toContain(capability)
    expect(mail?.body).not.toContain('hunter2')
  })

  it('stays quiet for the turn whose worker_done was rejected, not for later turns', () => {
    const ctx = setup()
    const writeToWorker = () => {
      const mail = ctx.db.insertMessage({
        from: 'term_coordinator',
        to: `dispatch:${ctx.dispatch.id}`,
        subject: 'Start',
        runId: ctx.run.id
      })
      ctx.db.markAsRead([mail.id])
    }
    const report = (type: 'worker_done' | 'heartbeat') => {
      const sent = ctx.db.insertMessage({
        from: HANDLE,
        to: `run:${ctx.run.id}`,
        subject: 'Done',
        type,
        payload: JSON.stringify({ taskId: ctx.dispatch.task_id, dispatchId: ctx.dispatch.id }),
        runId: ctx.run.id
      })
      ctx.db.convertLifecycleMessageToRejection(sent.id, 'worker_identity_changed', 'not the owner')
    }
    const stop = (stopKey: string, turnStartedAt: number) =>
      observeWorker(
        ctx.db,
        { kind: 'local', dispatch: ctx.dispatch },
        {
          presence: 'at-rest',
          fence: stopKey,
          legacyStopKey: stopKey,
          rest: { from: HANDLE, reason: 'finished', lastOutput: undefined, turnStartedAt }
        },
        ctx.deps
      )
    // The rejection is stored on the real clock: after 1970, before 2100.
    const before = 1_000
    const after = 4_102_444_800_000
    writeToWorker()
    report('heartbeat')
    stop('turn-1', before)
    expect(ctx.mail().map((m) => m.subject)).toEqual(['Worker stopped without reporting'])

    writeToWorker()
    report('worker_done')
    stop('turn-2', before)
    expect(ctx.mail()).toHaveLength(1)

    // A later idle turn that sent nothing is news, though the coordinator has not written since.
    stop('turn-3', after)
    expect(ctx.mail()).toHaveLength(2)
  })

  it('reports every idle stop after a write, though the write landed before the last report', async () => {
    const ctx = setup()
    const current = { row: hookRow({ state: 'working', stateStartedAt: 100 }) }
    const quiet: (() => void)[] = []
    const stops = terminal(ctx, current, {
      setTimer: (run) => {
        quiet.push(run)
        return { cancel: () => {} }
      }
    })
    const turn = async (stateStartedAt: number, during?: () => void) => {
      current.row = hookRow({ state: 'working', stateStartedAt: stateStartedAt - 1 })
      stops.observe({
        kind: 'observed',
        paneKey: PANE,
        workspace: { worktreeId: 'repo::/tmp/wt', sshHostId: null },
        phase: 'working',
        at: 1
      })
      current.row = hookRow({ stateStartedAt, lastAssistantMessage: 'Paused.' })
      stops.observe(moved('working', 'done'))
      // The coordinator's write lands in the quiet window, before Orca sees the worker resume.
      during?.()
      for (const run of quiet.splice(0)) {
        run()
      }
      await settle()
    }
    await turn(200, () => writeAndTake(ctx))
    await turn(300)
    expect(ctx.mail()).toHaveLength(2)
    writeAndTake(ctx)
    await turn(400)
    // Idle again with no new write: already told.
    await turn(500)
    expect(ctx.mail().map((m) => m.subject)).toEqual(
      Array(3).fill('Worker stopped without reporting')
    )
  })
  it("reports a background subagent's permission prompt with the dialog Claude paints after its hook", async () => {
    const ctx = setup()
    const current = { row: hookRow({ agentType: 'claude', state: 'working', stateStartedAt: 100 }) }
    // The lead ended its turn waiting on the subagent; its screen before and after the dialog painted.
    const idle = [
      "⏺ Waiting for the reviewer's report.",
      '✻ Waiting for 1 background agent to finish',
      '❯',
      '  ◯ general-purpose  Adversarial review of panel mock'
    ]
    const dialog = [
      ' Bash command · from the general-purpose agent',
      ' │ rm -f ./.rv-shot.mjs; node shot.mjs',
      ' │ Dangerous rm operation not ruled out — the shell may read this command differently than it was parsed',
      ' Do you want to proceed?',
      ' ❯ 1. Yes',
      '   2. No',
      ' Esc to cancel · Tab to amend · ctrl+x ctrl+k twice to stop background agents'
    ]
    const screens = [idle, idle, dialog]
    const stops = terminal(ctx, current, {
      readScreen: async () => screen(screens.shift() ?? dialog)
    })
    current.row = hookRow({
      agentType: 'claude',
      state: 'waiting',
      stateStartedAt: 300
    })
    stops.observe(moved('working', 'needs-you'))
    await vi.waitFor(() => expect(ctx.mail()).toHaveLength(1))
    expect(ctx.mail()[0].body).toContain('Do you want to proceed?')
  })
  it.each(['screen-unavailable', 'screen-stale'] as const)(
    'waits for the current grid instead of an older dialog in a %s read',
    async (source) => {
      const ctx = setup()
      const current = {
        row: hookRow({ agentType: 'claude', state: 'working', stateStartedAt: 100 })
      }
      // A rebuilding screen answers with transcript or an older frame; its footer belongs to a prompt already answered.
      const transcript = {
        ...screen([' Allow the earlier fetch?', ' ❯ 1. Yes', ' Esc to cancel · Tab to amend']),
        source
      }
      const dialog = screen([
        ' Bash command',
        ' │ git push --force',
        ' Do you want to proceed?',
        ' ❯ 1. Yes',
        '   2. No',
        ' Esc to cancel · Tab to amend'
      ])
      const reads = [transcript, dialog]
      const stops = terminal(ctx, current, {
        readScreen: async () => reads.shift() ?? dialog
      })
      current.row = hookRow({ agentType: 'claude', state: 'waiting', stateStartedAt: 300 })
      stops.observe(moved('working', 'needs-you'))
      await vi.waitFor(() => expect(ctx.mail()).toHaveLength(1))
      expect(ctx.mail()[0].body).toContain('git push --force')
      expect(ctx.mail()[0].body).not.toContain('Allow the earlier fetch?')
    }
  )

  it('does not page at startup for a turn its user stopped, or a session boundary', async () => {
    const ctx = setup()
    const current = { row: hookRow({ interrupted: true }) }
    const stops = terminal(ctx, current)
    await stops.reportRestingPane(PANE)
    current.row = hookRow({ sessionBoundary: true, stateStartedAt: 300 })
    await stops.reportRestingPane(PANE)
    expect(ctx.mail()).toHaveLength(0)
    current.row = hookRow({ stateStartedAt: 400 })
    await stops.reportRestingPane(PANE)
    expect(ctx.mail()).toHaveLength(1)
  })

  it("drops a stop whose agent was relaunched while its screen was read, since the new one's turn is its own", async () => {
    const ctx = setup()
    const current = { row: hookRow({ stateStartedAt: 300 }) }
    const incarnations = ['proc-1', 'proc-2']
    const stops = terminal(ctx, current, {
      getProcessIncarnation: () => incarnations.shift() ?? 'proc-2'
    })
    await stops.reportRestingPane(PANE)
    expect(ctx.mail()).toHaveLength(0)
  })

  it('keeps the words before trailing blank output in the report', async () => {
    const ctx = setup()
    const current = {
      row: hookRow({ stateStartedAt: 300, lastAssistantMessage: `Tests pass.${' '.repeat(2_500)}` })
    }
    await terminal(ctx, current).reportRestingPane(PANE)
    expect(ctx.mail()[0]?.body).toContain('Tests pass.')
  })

  it('reports an approval seen on a prompt already reported without one', async () => {
    const ctx = setup()
    const current = { row: hookRow({ state: 'waiting', stateStartedAt: 300 }) }
    let open: WorkerApprovalPayload | null = null
    const reported: string[] = []
    const stops = terminal(ctx, current, {
      takeOpenApproval: async () => open,
      markApprovalReported: (approvalId) => reported.push(approvalId)
    })
    await stops.reportRestingPane(PANE)
    expect(ctx.mail()).toHaveLength(1)
    open = {
      v: 1,
      approvalId: 'apr_open',
      state: 'open',
      worker: { handle: HANDLE, dispatchId: ctx.dispatch.id, taskId: ctx.dispatch.task_id },
      summary: { title: 'Allow Bash?', detail: null, reason: null },
      allowedActions: ['allow', 'deny']
    }
    await stops.reportRestingPane(PANE)
    await stops.reportRestingPane(PANE)
    expect(ctx.mail().map((message) => message.subject)).toEqual([
      'Worker is waiting on a prompt',
      'Worker is waiting for permission'
    ])
    expect(reported).toEqual(['apr_open', 'apr_open'])
  })
})

describe('terminal worker turn failures', () => {
  const failed = (message: string, error?: string) =>
    hookRow({
      agentType: 'claude',
      stateStartedAt: 300,
      mainAgent: {
        state: 'done',
        outcome: 'failure',
        stateStartedAt: 300,
        ...(error ? { failure: { error, message } } : {})
      }
    })
  // Claude's menu after a usage limit is a numbered dialog, painted after its StopFailure.
  const menu = screen([
    "You've hit your session limit · resets 3pm (America/New_York)",
    ' What do you want to do?',
    ' ❯ 1. Stop and wait for limit to reset',
    '   2. Upgrade your plan',
    ' Enter to select · Esc to cancel'
  ])

  it('reports a usage limit in the words chat workers use, not the menu Claude opens after it', async () => {
    const ctx = setup()
    const current = {
      row: failed("You've hit your session limit · resets 3pm (America/New_York)", 'rate_limit')
    }
    await terminal(ctx, current, { readScreen: async () => menu }).reportRestingPane(PANE)
    const [report] = ctx.mail()
    expect(report?.subject).toBe('Worker hit its usage limit')
    expect(report?.body).toContain('Error: Claude hit its session limit.')
    expect(report?.body).toContain(
      "Details from the agent: You've hit your session limit · resets 3pm (America/New_York)"
    )
    expect(report?.body).toContain(
      `orchestration worker-start --task ${ctx.dispatch.task_id} --retry-of ${ctx.dispatch.id} --agent <other>`
    )
    expect(report?.body).not.toContain('What do you want to do?')
    expect(report?.body).not.toContain('needs a person')
  })

  it('holds back a usage limit while the worker waits for mail, as any terminal rest', async () => {
    const ctx = setup()
    ctx.waiting.add(`dispatch:${ctx.dispatch.id}`)
    const current = {
      row: failed("You've hit your session limit · resets 3pm (America/New_York)", 'rate_limit')
    }
    await terminal(ctx, current).reportRestingPane(PANE)
    expect(ctx.mail()).toHaveLength(0)
  })

  it('reports a rate limit with no limit line as a failed response', async () => {
    const ctx = setup()
    const current = {
      row: failed('API Error: Request rejected (429) · Please try again later.', 'rate_limit')
    }
    await terminal(ctx, current).reportRestingPane(PANE)
    const [report] = ctx.mail()
    expect(report?.subject).toBe('Worker stopped on an error without reporting')
    expect(report?.body).toContain(
      "Error: Claude couldn't finish this response: API Error: Request rejected (429) · Please try again later."
    )
    expect(report?.body).not.toContain('--retry-of')
    expect(report?.body).not.toContain('Details from the agent')
  })

  it('keeps the screen report for a failure that names no error', async () => {
    const ctx = setup()
    const current = { row: failed("You've hit your session limit · resets 3pm") }
    await terminal(ctx, current).reportRestingPane(PANE)
    const [report] = ctx.mail()
    expect(report?.subject).toBe('Worker stopped on an error without reporting')
    expect(report?.body).toContain(
      `Worker ${HANDLE} ended its turn on an error without sending worker_done`
    )
    expect(report?.body).toContain('Selected model is at capacity')
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
    const report = chatWorkerTurnStopReporter(ctx.deps, (run) => {
      timers.push(run)
    })
    return {
      finish: (turnId: string) =>
        report.onTurnAttention(completion('success', turnId), () => ({
          status,
          lastAssistantMessage: 'Done.'
        })),
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
  it('reports every idle stop after a write, though the write landed before the last report', () => {
    const ctx = setup(formatOrcaSessionAddress(CHAT_SESSION))
    const chat = chatWithTimers(ctx)
    chat.finish('turn-1')
    // The coordinator's write lands in the quiet window, before the stop is reported.
    writeAndTake(ctx)
    chat.runTimers()
    chat.finish('turn-2')
    chat.runTimers()
    expect(ctx.mail()).toHaveLength(2)
    writeAndTake(ctx)
    chat.finish('turn-3')
    chat.runTimers()
    // Idle again with no new write: already told.
    chat.finish('turn-4')
    chat.runTimers()
    expect(ctx.mail().map((m) => m.subject)).toEqual(
      Array(3).fill('Worker stopped without reporting')
    )
  })

  it('does not report again a rest that an earlier build already reported, after an upgrade', () => {
    const ctx = setup(formatOrcaSessionAddress(CHAT_SESSION))
    writeAndTake(ctx)
    // The earlier build keyed an idle finish by the coordinator mail the worker had taken.
    ctx.db.insertMessage({
      id: stopReportId(ctx.dispatch.id, 'finished:1'),
      from: formatOrcaSessionAddress(CHAT_SESSION),
      to: `run:${ctx.run.id}`,
      subject: 'Worker stopped without reporting',
      type: 'escalation',
      runId: ctx.run.id
    })
    const chat = chatWithTimers(ctx)
    chat.finish('turn-1')
    chat.runTimers()
    expect(ctx.mail()).toHaveLength(1)
    writeAndTake(ctx)
    chat.finish('turn-2')
    chat.runTimers()
    expect(ctx.mail()).toHaveLength(2)
  })
})

describe('worker exits', () => {
  const exit = (ctx: ReturnType<typeof setup>) => ({
    presence: 'gone' as const,
    fence: 'proc-1',
    legacyStopKey: 'gone',
    gone: { from: HANDLE, reason: 'exited' as const, lastOutput: undefined },
    settle: () => {
      const status = ctx.db.failDispatch(ctx.dispatch.id, 'process exited')?.status
      return status === 'failed' || status === 'circuit_broken' ? status : undefined
    }
  })
  const target = (ctx: ReturnType<typeof setup>) => ({
    kind: 'local' as const,
    dispatch: ctx.dispatch
  })

  it('keeps an exit report and its settlement when waking the coordinator fails', () => {
    const ctx = setup()
    ctx.notify.mockImplementation(() => {
      throw new Error('wake failed')
    })
    expect(() => observeWorker(ctx.db, target(ctx), exit(ctx), ctx.deps)).toThrow('wake failed')
    expect(ctx.mail()).toHaveLength(1)
    expect(ctx.db.getDispatchContextById(ctx.dispatch.id)?.status).toBe('failed')
  })

  it('sends an exit report whose mail failed when it is looked at again', () => {
    const ctx = setup()
    vi.spyOn(ctx.db, 'insertMessage').mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    observeWorker(ctx.db, target(ctx), exit(ctx), ctx.deps)
    expect(ctx.mail()).toHaveLength(0)
    expect(ctx.db.getDispatchContextById(ctx.dispatch.id)?.status).toBe('failed')
    expect(reconsiderWorkerRest(ctx.db, ctx.dispatch.id, ctx.deps)).toBe(true)
    expect(reconsiderWorkerRest(ctx.db, ctx.dispatch.id, ctx.deps)).toBe(false)
    expect(ctx.mail().map((message) => message.subject)).toEqual([
      'Worker exited without reporting'
    ])
  })
})

describe('worker rests', () => {
  const rest = (ctx: ReturnType<typeof setup>, fence: string) =>
    observeWorker(
      ctx.db,
      { kind: 'local', dispatch: ctx.dispatch },
      {
        presence: 'at-rest',
        fence,
        legacyStopKey: fence,
        rest: { from: HANDLE, reason: 'finished', lastOutput: 'Done.' }
      },
      ctx.deps
    )

  it('counts a committed report as sent though waking the coordinator failed', () => {
    const ctx = setup()
    ctx.notify.mockImplementation(() => {
      throw new Error('wake failed')
    })
    expect(rest(ctx, 'proc:1')).toBe(true)
    // Another idle turn with no new coordinator mail repeats what the coordinator was told.
    rest(ctx, 'proc:2')
    expect(ctx.mail()).toHaveLength(1)
  })

  it("decides a creator's held-back finish again once its last helper settles", () => {
    const ctx = setup()
    const task = ctx.db.createTask({ spec: 'help', runId: ctx.run.id })
    const helper = createRootDispatch(ctx.db, task.id, 'term_helper')
    ctx.db.db
      .prepare('UPDATE dispatch_contexts SET creator_dispatch_id = ? WHERE id = ?')
      .run(ctx.dispatch.id, helper.id)
    rest(ctx, 'proc:1')
    expect(ctx.mail()).toHaveLength(0)
    ctx.db.completeDispatch(helper.id)
    reconsiderCreatorRest(`dispatch:${helper.id}`, ctx.deps)
    expect(ctx.mail()).toHaveLength(1)
  })

  it('does not report a rest whose stop the coordinator asked for while its screen was read', async () => {
    const ctx = setup()
    const current = { row: hookRow({ stateStartedAt: 300 }) }
    const stops = terminal(ctx, current, {
      readScreen: async () => {
        ctx.db.getWorkerDispatch = () =>
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reporter reads only the state.
          ({ state: 'stopping' }) as ReturnType<typeof ctx.db.getWorkerDispatch>
        return screen(['$'])
      }
    })
    current.row = hookRow({ state: 'waiting', stateStartedAt: 300 })
    await stops.reportRestingPane(PANE)
    expect(ctx.mail()).toHaveLength(0)
  })
})

describe('remote worker presence', () => {
  function attachment() {
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
    const relayed = () =>
      db.db
        .prepare("SELECT message_id FROM federation_relay_items WHERE direction = 'to_home'")
        .all()
    const deps = { getDb: () => db, isWaitingForMail: () => false, notify: vi.fn() }
    const target = {
      kind: 'remote' as const,
      attachment: { dispatch_id: 'ctx_remote', task_id: 'task_remote' }
    }
    return { db, relayed, deps, target }
  }

  it('relays an exit to the Run home once, however often it is seen', () => {
    const { db, relayed, deps, target } = attachment()
    const gone = {
      presence: 'gone' as const,
      fence: 'proc-1',
      legacyStopKey: 'gone',
      gone: { from: HANDLE, reason: 'exited' as const, lastOutput: undefined }
    }
    expect(observeWorker(db, target, gone, deps)).toBe(true)
    observeWorker(db, target, gone, deps)
    expect(relayed()).toHaveLength(1)
  })
})
