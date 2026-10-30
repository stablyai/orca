import { describe, expect, it, vi } from 'vitest'
import type { AgentPaneChange } from '../../agent-hooks/agent-transition-detector'
import type { AgentStatusIpcPayload } from '../../../shared/agent-status-ipc-payload'
import type { AgentSessionTurnCompletionEvent } from '../../../shared/agent-session-wire'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { formatOrcaSessionAddress } from '../../../shared/orca-session-address'
import { testOrcaSessionId } from '../../../shared/orca-session-address-test-fixture'
import { chatWorkerTurnStopReporter } from './chat-worker-turn-stops'
import { OrchestrationDb } from './db'
import { createRootDispatch } from './db/root-dispatch-test-fixture'
import { TerminalWorkerTurnStops } from './terminal-worker-turn-stops'
import { reportWorkerTurnStop } from './worker-turn-stop-report'

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

  it('reports a worker stopped at an approval prompt', async () => {
    const ctx = setup()
    const stops = terminal(ctx, { row: hookRow({ state: 'blocked' }) })
    stops.observe(moved('working', 'needs-you'))
    await settle()
    expect(ctx.mail()[0]?.subject).toBe('Worker is waiting on a prompt')
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
  const completion = (outcome: 'success' | 'failure'): AgentSessionTurnCompletionEvent => ({
    type: 'completion',
    completion: {
      scope: {
        executionHostId: LOCAL_EXECUTION_HOST_ID,
        wslDistro: null,
        workspaceId: 'repo::/tmp/wt',
        workspaceKind: 'git-worktree'
      },
      sessionId: CHAT_SESSION,
      turnId: 'turn-1',
      outcome,
      completedAt: 1
    }
  })

  it('reports a finished turn and leaves failures to the chat error escalation', () => {
    const ctx = setup(formatOrcaSessionAddress(CHAT_SESSION))
    const report = chatWorkerTurnStopReporter(ctx.deps)
    const status = () => ({ status: 'idle' as const, lastAssistantMessage: 'Read the files.' })
    report(completion('failure'), status)
    expect(ctx.mail()).toHaveLength(0)
    report(completion('success'), status)
    report(completion('success'), status)
    expect(ctx.mail()).toHaveLength(1)
    expect(ctx.mail()[0].body).toContain('Read the files.')
  })
})

describe('remote worker turn stops', () => {
  it('relays the report to the Run home under a stable id', () => {
    const db = new OrchestrationDb(':memory:')
    const enqueueFederationRelay = vi.spyOn(db, 'enqueueFederationRelay')
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
