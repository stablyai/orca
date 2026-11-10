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
import { reportWorkerTurnStop } from './worker-turn-stop-report'
import type { ChatWorkerPrompt } from '../approvals/chat-worker-approval-prompt'
import type { AgentJournalApprovalItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'

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
  const deps = { getDb: () => db, isWaitingForMail: (m: string) => waiting.has(m), notify }
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
  it('tells the Run once, with the last output, when a worker turn ends without worker_done', async () => {
    const ctx = setup()
    const current = {
      row: hookRow({ mainAgent: { state: 'done', outcome: 'failure', stateStartedAt: 200 } })
    }
    const stops = terminal(ctx, current)
    stops.observe(moved('working', 'done'))
    await settle()
    stops.observe(moved('working', 'done'))
    await settle()
    const [message, ...rest] = ctx.mail()
    expect(rest).toHaveLength(0)
    expect(message).toMatchObject({
      type: 'escalation',
      priority: 'high',
      subject: 'Worker stopped on an error without reporting'
    })
    expect(message.body).toContain('Selected model is at capacity')
    expect(message.body).toContain(`worker-read --dispatch ${ctx.dispatch.id}`)
    expect(ctx.notify).toHaveBeenCalledWith(message.to_handle, 'escalation')
    ctx.db.insertMessage({
      from: 'term_coordinator',
      to: `dispatch:${ctx.dispatch.id}`,
      subject: 'retry',
      runId: ctx.run.id
    })

    // The coordinator's reply starts a new turn; its stop is reported again.
    current.row = hookRow({
      stateStartedAt: 300,
      lastAssistantMessage: 'Read the files. --dispatch-capability dcap_secretsecretsecretsecret00'
    })
    stops.observe(moved('working', 'done'))
    await settle()
    expect(ctx.mail().map((m) => m.subject)).toContain('Worker stopped without reporting')
    // A clean finish quotes the agent's own words, not the screen.
    expect(ctx.mail()[1].body).toContain('Read the files.')
    expect(ctx.mail()[1].body).not.toContain('Selected model')
    expect(ctx.mail()[1].body).not.toContain('dcap_secretsecretsecretsecret00')
    expect(ctx.mail()).toHaveLength(2)
  })

  it('waits for a lead and its children to settle before reporting the finish', async () => {
    const ctx = setup()
    const current = { row: hookRow({ state: 'working', turnCompletedAt: 150 }) }
    const stops = terminal(ctx, current)
    stops.observe({
      kind: 'observed',
      paneKey: PANE,
      workspace: { worktreeId: 'repo::/tmp/wt', sshHostId: null },
      phase: 'working',
      at: 1
    })
    await settle()
    expect(ctx.mail()).toHaveLength(0)
    current.row = hookRow({ turnCompletedAt: 150 })
    stops.observe(moved('working', 'done'))
    await settle()
    expect(ctx.mail()).toHaveLength(1)
  })

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

  it('escalates a prompt or error while its helper is open, but not a clean rest', async () => {
    const ctx = setup()
    const helperTask = ctx.db.createTask({ spec: 'help', runId: ctx.run.id })
    ctx.db.createDispatchContext({
      taskId: helperTask.id,
      assigneeHandle: 'term_helper',
      creator: { kind: 'terminal', handle: HANDLE, paneKey: PANE },
      maxDepth: Number.MAX_SAFE_INTEGER
    })
    expect(ctx.db.hasOpenHelperDispatch(ctx.dispatch.id)).toBe(true)
    const target = { kind: 'local' as const, dispatch: ctx.dispatch }
    const stop = { from: HANDLE, lastOutput: undefined }
    reportWorkerTurnStop(ctx.db, target, { ...stop, stopKey: '1', reason: 'finished' }, ctx.deps)
    expect(ctx.mail()).toHaveLength(0)
    reportWorkerTurnStop(ctx.db, target, { ...stop, stopKey: '2', reason: 'needs-input' }, ctx.deps)
    reportWorkerTurnStop(ctx.db, target, { ...stop, stopKey: '3', reason: 'errored' }, ctx.deps)
    expect(ctx.mail().map((m) => m.subject)).toEqual([
      'Worker is waiting on a prompt',
      'Worker stopped on an error without reporting'
    ])
  })

  it('stays quiet for a resumed turn, a settled Dispatch, or a deliberate wait', async () => {
    const resumed = setup()
    const current = { row: hookRow({}) }
    const stops = terminal(resumed, current)
    stops.observe(moved('working', 'done'))
    current.row = hookRow({ state: 'working', stateStartedAt: 250 })
    await settle()
    expect(resumed.mail()).toHaveLength(0)

    const settled = setup()
    settled.db.completeDispatch(settled.dispatch.id)
    terminal(settled, { row: hookRow({}) }).observe(moved('working', 'done'))
    await settle()
    expect(settled.mail()).toHaveLength(0)

    const waiting = setup()
    waiting.waiting.add(`dispatch:${waiting.dispatch.id}`)
    terminal(waiting, { row: hookRow({}) }).observe(moved('working', 'done'))
    await settle()
    expect(waiting.mail()).toHaveLength(0)
  })

  it('reports an idle finish once until the coordinator writes to the worker again', async () => {
    const ctx = setup()
    const current = { row: hookRow({}) }
    const stops = terminal(ctx, current)
    // A worker that wakes on its own schedule ends turn after turn without new mail.
    for (const stateStartedAt of [200, 300, 400]) {
      current.row = hookRow({ stateStartedAt })
      stops.observe(moved('working', 'done'))
      await settle()
    }
    expect(ctx.mail().map((m) => m.subject)).toEqual(['Worker stopped without reporting'])
    expect(ctx.mail()[0].body).toContain('later idle turns are not reported until you write to it')

    const mail = ctx.db.insertMessage({
      from: 'term_coordinator',
      to: `dispatch:${ctx.dispatch.id}`,
      subject: 'check again',
      type: 'status',
      runId: ctx.run.id
    })
    // A helper's reports up to its creator, even a status from a reminted handle, are not the coordinator asking again.
    const helperPane = makePaneKey('tab-helper', '33333333-3333-4333-8333-333333333333')
    const helper = ctx.db.createDispatchContext({
      taskId: ctx.db.createTask({ spec: 'help', runId: ctx.run.id }).id,
      assigneeHandle: 'term_helper',
      assigneePaneKey: helperPane,
      creator: { kind: 'terminal', handle: HANDLE, paneKey: PANE },
      maxDepth: Number.MAX_SAFE_INTEGER
    })
    // Nor are its own heartbeats or a sibling worker's broadcast.
    createRootDispatch(
      ctx.db,
      ctx.db.createTask({ spec: 'sibling', runId: ctx.run.id }).id,
      'term_sibling'
    )
    const helperReports = [
      { from: 'term_helper', type: 'status' as const },
      { from: 'term_helper_reminted', senderPaneKey: helperPane, type: 'status' as const },
      { from: HANDLE, type: 'heartbeat' as const },
      { from: 'term_sibling', type: 'status' as const }
    ].map((sender) =>
      ctx.db.insertMessage({
        ...sender,
        to: `dispatch:${ctx.dispatch.id}`,
        subject: 'worker mail',
        runId: ctx.run.id
      })
    )
    ctx.db.markAsRead(helperReports.map((report) => report.id))
    ctx.db.completeDispatch(helper.id)
    // Mail the worker has not taken yet belongs to its next turn, not to a stop seen before it arrived.
    current.row = hookRow({ stateStartedAt: 500 })
    stops.observe(moved('working', 'done'))
    await settle()
    expect(ctx.mail()).toHaveLength(1)

    ctx.db.markAsDelivered([mail.id], `dispatch:${ctx.dispatch.id}`)
    current.row = hookRow({ stateStartedAt: 600 })
    stops.observe(moved('working', 'done'))
    await settle()
    expect(ctx.mail()).toHaveLength(1)

    ctx.db.markAsRead([mail.id])
    current.row = hookRow({ stateStartedAt: 700 })
    stops.observe(moved('working', 'done'))
    await settle()
    expect(ctx.mail()).toHaveLength(2)

    // The coordinator later taking a Dispatch of its own does not turn its earlier guidance into worker mail.
    const later = createRootDispatch(
      ctx.db,
      ctx.db.createTask({ spec: 'later', runId: ctx.run.id }).id,
      'term_coordinator'
    )
    ctx.db.db
      .prepare(
        "UPDATE dispatch_contexts SET created_at = datetime('now', '+1 minute') WHERE id = ?"
      )
      .run(later.id)
    const next = ctx.db.insertMessage({
      from: 'term_run_owner',
      to: `dispatch:${ctx.dispatch.id}`,
      subject: 'one more',
      runId: ctx.run.id
    })
    ctx.db.markAsRead([next.id])
    current.row = hookRow({ stateStartedAt: 800 })
    stops.observe(moved('working', 'done'))
    await settle()
    expect(ctx.mail()).toHaveLength(3)
  })

  it('stays quiet after the worker asks and ends its turn, until the answer arrives', async () => {
    const ctx = setup()
    const question = ctx.db.createQuestion({
      runId: ctx.run.id,
      dispatchId: ctx.dispatch.id,
      askerHandle: HANDLE,
      question: 'Which file?'
    })
    const current = { row: hookRow({}) }
    const stops = terminal(ctx, current)
    stops.observe(moved('working', 'done'))
    await settle()
    expect(ctx.mail()).toHaveLength(0)

    ctx.db.answerQuestion({
      messageId: question.message.id,
      runId: ctx.run.id,
      consumerGeneration: ctx.run.consumer_generation,
      body: 'main.ts'
    })
    current.row = hookRow({ stateStartedAt: 300 })
    stops.observe(moved('working', 'done'))
    await settle()
    expect(ctx.mail().map((m) => m.subject)).toEqual(['Worker stopped without reporting'])
  })

  it('reports a later stall once new mail reached the worker, though its question is pending', async () => {
    const ctx = setup()
    // Mail stored before the question, even in the same second, does not end the asking turn's mute.
    ctx.db.insertMessage({
      from: 'term_coordinator',
      to: `dispatch:${ctx.dispatch.id}`,
      subject: 'Steer',
      runId: ctx.run.id
    })
    const question = ctx.db.createQuestion({
      runId: ctx.run.id,
      dispatchId: ctx.dispatch.id,
      askerHandle: HANDLE,
      question: 'Which file?'
    })
    const current = { row: hookRow({}) }
    const stops = terminal(ctx, current)
    stops.observe(moved('working', 'done'))
    await settle()
    expect(ctx.mail()).toHaveLength(0)

    ctx.db.insertMessage({
      from: 'term_coordinator',
      to: `dispatch:${ctx.dispatch.id}`,
      subject: 'Change of plan',
      runId: ctx.run.id
    })
    current.row = hookRow({ stateStartedAt: 300 })
    stops.observe(moved('working', 'done'))
    await settle()
    expect(ctx.db.getQuestion(question.message.id)?.status).toBe('pending')
    expect(ctx.mail().map((m) => m.subject)).toEqual(['Worker stopped without reporting'])
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
    let status: 'idle' | 'working' = 'idle'
    const report = chatWorkerTurnStopReporter(ctx.deps, (run) => timers.push(run))
    return {
      finish: (turnId: string) =>
        report(completion('success', turnId), () => ({ status, lastAssistantMessage: 'Done.' })),
      setStatus: (next: typeof status) => {
        status = next
      },
      runTimers: () => {
        for (const run of timers.splice(0)) {
          run()
        }
      }
    }
  }

  it('does not blame a follow-up for the turn whose report claimed it', () => {
    const ctx = setup()
    const followUp = startingFollowUp(ctx)
    const chat = chatWithTimers(ctx)

    chat.finish('turn-reported')
    chat.runTimers()
    ctx.db.markWorkerDispatchReady(followUp)
    chat.setStatus('working')
    chat.runTimers()

    expect(ctx.mail()).toHaveLength(0)
  })

  it('drops a pending stop once a later turn of the follow-up fails', () => {
    const ctx = setup()
    const followUp = startingFollowUp(ctx)
    ctx.db.markWorkerDispatchReady(followUp)
    const timers: (() => void)[] = []
    const report = chatWorkerTurnStopReporter(ctx.deps, (run) => timers.push(run))
    const idle = () => ({ status: 'idle' as const, lastAssistantMessage: 'It failed.' })

    report(completion('success', 'turn-reported'), idle)
    report(completion('failure', 'turn-follow-up'), idle)
    for (const run of timers.splice(0)) {
      run()
    }

    expect(ctx.mail()).toHaveLength(0)
  })

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

describe('remote worker turn stops', () => {
  it('relays the report to the Run home under a stable id', () => {
    const db = new OrchestrationDb(':memory:')
    const enqueueFederationRelay = vi.spyOn(db, 'enqueueFederationRelay')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const attachment = { dispatch_id: 'dsp_remote', task_id: 'task_remote' }
    const stop = { from: HANDLE, stopKey: 'k', reason: 'finished' as const, lastOutput: 'bye' }
    const deps = { getDb: () => db, isWaitingForMail: () => false, notify: vi.fn() }
    const target = { kind: 'remote' as const, attachment }
    reportWorkerTurnStop(db, target, stop, deps)
    reportWorkerTurnStop(db, target, stop, deps)
    const [first, second] = enqueueFederationRelay.mock.calls.map(([params]) => params)
    expect(first).toMatchObject({
      dispatchId: 'dsp_remote',
      direction: 'to_home',
      kind: 'escalation'
    })
    expect(first.messageId).toBe(second.messageId)
    // The repeat is a no-op, not a failed relay.
    expect(warn).not.toHaveBeenCalled()
    const relayed = JSON.parse(first.payload)
    expect(relayed).toMatchObject({ type: 'escalation', priority: 'high' })
    expect(JSON.parse(relayed.payload)).toMatchObject({ stopReason: 'finished' })

    // A worker_done still queued for the home is a report, not a silent stop.
    db.enqueueFederationRelay({
      dispatchId: 'dsp_remote',
      direction: 'to_home',
      kind: 'worker_done',
      payload: '{}'
    })
    enqueueFederationRelay.mockClear()
    reportWorkerTurnStop(db, target, { ...stop, stopKey: 'k2' }, deps)
    expect(enqueueFederationRelay).not.toHaveBeenCalled()
  })
})

describe('chat worker approvals', () => {
  const promptEvent = (promptId: string): AgentSessionTurnCompletionEvent => ({
    type: 'prompt',
    prompt: {
      scope: {
        executionHostId: LOCAL_EXECUTION_HOST_ID,
        wslDistro: null,
        workspaceId: 'repo::/tmp/wt',
        workspaceKind: 'git-worktree'
      },
      sessionId: CHAT_SESSION,
      promptId,
      raisedAt: 1
    }
  })
  const finished = (turnId: string): AgentSessionTurnCompletionEvent => ({
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
      outcome: 'success',
      completedAt: 2
    }
  })
  const approval = (selected: string | null): AgentJournalApprovalItem => ({
    kind: 'approval',
    title: 'Allow Bash?',
    detail: 'rm -rf build',
    options: [
      { id: 'allow', label: 'Allow', intent: 'allow_once' },
      { id: 'deny', label: 'Deny', intent: 'reject_once' }
    ],
    resolution: selected
      ? {
          state: 'resolved',
          selectedOptionId: selected,
          resolvedBy: 'desktop-renderer',
          resolvedAt: 2
        }
      : { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
  })

  function chat() {
    const ctx = setup(formatOrcaSessionAddress(CHAT_SESSION))
    const prompts = new Map<string, ChatWorkerPrompt>()
    const report = chatWorkerTurnStopReporter(
      ctx.deps,
      (run) => run(),
      async (_sessionId, itemId) => prompts.get(itemId) ?? null
    )
    const idle = () => ({ status: 'idle' as const, lastAssistantMessage: '' })
    const all = () => ctx.db.getUnreadRunMailbox(ctx.run.id, 100)
    return { ctx, prompts, report, idle, all }
  }

  it('escalates one open approval once, with its structured payload', async () => {
    const { ctx, prompts, report, idle } = chat()
    prompts.set('item_1', { revision: 1, body: approval(null) })

    report(promptEvent('item_1'), idle)
    report(promptEvent('item_1'), idle)
    await settle()

    const mail = ctx.mail()
    expect(mail).toHaveLength(1)
    expect(mail[0].subject).toBe('Worker is waiting on approval')
    expect(mail[0].body).toContain(
      `orchestration deny --dispatch ${ctx.dispatch.id} --prompt item_1`
    )
    expect(mail[0].body).not.toContain('Answer it with')
    expect(JSON.parse(mail[0].payload ?? '{}').approval).toEqual({
      v: 1,
      approvalId: 'item_1',
      state: 'open',
      worker: {
        handle: formatOrcaSessionAddress(CHAT_SESSION),
        dispatchId: ctx.dispatch.id,
        taskId: ctx.dispatch.task_id
      },
      summary: { title: 'Allow Bash?', detail: 'rm -rf build', reason: null },
      allowedActions: ['allow', 'deny']
    })
  })

  it('closes a reported approval once after it is answered in the worker chat', async () => {
    const { prompts, report, idle, all } = chat()
    prompts.set('item_1', { revision: 1, body: approval(null) })
    report(promptEvent('item_1'), idle)
    await settle()

    prompts.set('item_1', { revision: 2, body: approval('deny') })
    report(finished('turn-2'), idle)
    report(finished('turn-3'), idle)
    await settle()

    const closing = all().filter((message) => message.type === 'status')
    expect(closing).toHaveLength(1)
    expect(closing[0].body).toContain("Denied in the worker's own chat")
    expect(JSON.parse(closing[0].payload ?? '{}').approval).toMatchObject({
      approvalId: 'item_1',
      state: 'answered',
      allowedActions: [],
      outcome: { by: 'worker-chat', decision: 'deny' }
    })
  })

  it('tells the coordinator a plain prompt needs a person, not a message', async () => {
    const { ctx, report, idle } = chat()

    report(promptEvent('question_1'), idle)
    await settle()

    const [mail] = ctx.mail()
    expect(mail.subject).toBe('Worker is waiting on a prompt')
    expect(mail.body).toContain('A message does not answer it')
    expect(mail.body).not.toContain('Answer it with')
  })
})
