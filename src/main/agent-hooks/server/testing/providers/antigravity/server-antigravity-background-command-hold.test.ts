import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentHookServer } from '../../../agent-hook-server'
import {
  ANTIGRAVITY_PARENT_WAKE_GRACE_MS,
  HOOK_SILENCE_BEFORE_PROGRAM_STATUS_FALLBACK_MS
} from '../../../program-status/hook-precedence'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../../../shared/agent-status/contracts/agent-status-freshness'
import { buildBody, PANE, postHookEvent } from '../../server.test-fixtures'
import { createShedSubagentsField } from '../../../../../../shared/agent-hook-listener/transport/agent-hook-relay'

let dir: string
let server: AgentHookServer

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'orca-agy-background-command-'))
  server = new AgentHookServer()
  await server.start({ env: 'production', userDataPath: dir })
})

afterEach(() => {
  vi.useRealTimers()
  server.stop()
  rmSync(dir, { recursive: true, force: true })
})

const turn = { conversationId: 'parent', lastUserInput: 'start the job' }

async function agyHook(hookEventName: string, payload: Record<string, unknown>): Promise<void> {
  const isRoot = payload.conversationId === undefined || payload.conversationId === 'parent'
  const response = await postHookEvent(
    server,
    buildBody(
      {
        ...turn,
        ...(isRoot && hookEventName === 'PreInvocation' ? { modelName: 'model-r' } : {}),
        ...payload
      },
      { hookEventName }
    ),
    '/hook/antigravity'
  )
  expect(response.status).toBe(204)
}

function programDone(): void {
  // agy's OSC 7501 says done at every turn end, including one that waits on a background command.
  server.ingestTerminalStatus({
    paneKey: PANE,
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    connectionId: null,
    fromProgramStatus: true,
    payload: { prompt: '', state: 'done', agentType: 'antigravity' }
  })
}

const state = () => server.getStatusSnapshot()[0]?.state
const worker = (id: string) => ({ id, state: 'working' as const, startedAt: 1, description: id })
const transcriptPollMs = 1000

function fakeTranscriptClock(): void {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'performance'] })
}

async function waitForSettledRoster(ids: string[]): Promise<void> {
  // The deadline starts the poll. Wait for the row publication while filesystem I/O catches up.
  if (vi.isFakeTimers()) {
    await vi.advanceTimersByTimeAsync(transcriptPollMs)
  }
  const matches = () => {
    const row = server.getStatusSnapshotForPane(PANE)[0]
    return (
      row !== undefined &&
      row.antigravitySpawnPending === undefined &&
      (ids.length === 0
        ? row.subagents === undefined
        : row.subagents?.length === ids.length &&
          ids.every((id, index) => row.subagents?.[index]?.id === id))
    )
  }
  if (!matches()) {
    await new Promise<void>((resolve) => {
      const stop = server.subscribeStatusRowMutations(() => {
        if (matches()) {
          stop()
          resolve()
        }
      })
    })
  }
}

const workflowCall = {
  stepIdx: 3,
  toolCall: { id: 'workflow-3', name: 'run_workflow', args: { Script: 'print("complete")' } }
}

it.each([
  ['', false],
  [' and a workflow that started no subagent', true]
])(
  'keeps a turn waiting on a background command%s monitoring past the hook-silence fallback, then bounds it',
  async (_case, workflow) => {
    const command = {
      stepIdx: 2,
      toolCall: { name: 'run_command', args: { CommandLine: 'sleep 600', IsDaemon: false } }
    }
    await agyHook('PreInvocation', {})
    await agyHook('PreToolUse', command)
    if (workflow) {
      await agyHook('PreToolUse', workflowCall)
      await agyHook('PostToolUse', { ...workflowCall, error: '' })
    }
    await agyHook('Stop', { fullyIdle: false, terminationReason: 'NO_TOOL_CALL' })
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    // agy reports this done once; only the hook-silence recheck can offer it again.
    programDone()

    vi.advanceTimersByTime(HOOK_SILENCE_BEFORE_PROGRAM_STATUS_FALLBACK_MS + 1)
    expect(server.getStatusSnapshot()[0]).toMatchObject({
      state: 'working',
      workingMode: 'monitoring'
    })

    vi.advanceTimersByTime(AGENT_STATUS_STALE_AFTER_MS)
    expect(state()).toBe('done')
  }
)

it('ends the turn on root idle after a workflow that started no subagent', async () => {
  await agyHook('PreInvocation', {})
  await agyHook('PreToolUse', workflowCall)
  await agyHook('PostToolUse', { ...workflowCall, error: '' })
  expect(state()).toBe('working')

  await agyHook('Stop', { fullyIdle: true, terminationReason: 'NO_TOOL_CALL' })
  expect(state()).toBe('done')
})

const invoke = (stepIdx = 2) => ({
  stepIdx,
  toolCall: { id: `invoke-${stepIdx}`, name: 'invoke_subagent', args: { Prompt: 'ls' } }
})
const subagentCall = invoke()
const child = { conversationId: 'child', lastUserInput: '' }

// Order captured from agy 1.5.12: the parent stops busy and no parent hook follows its subagent's idle Stop.
async function parentStopsWhileSubagentRuns(ids = ['child']): Promise<void> {
  const transcriptPath = brainWithChildDescriptor(ids)
  await agyHook('PreInvocation', { transcriptPath })
  for (const [index, conversationId] of ids.entries()) {
    const call = invoke(index + 2)
    await agyHook('PreToolUse', call)
    await agyHook('PostToolUse', call)
    await agyHook('PreInvocation', { ...child, conversationId })
  }
  await agyHook('PostInvocation', {})
  await agyHook('Stop', { fullyIdle: false, terminationReason: 'NO_TOOL_CALL' })
  await agyHook('PostInvocation', child)
  await waitForSettledRoster(ids)
}

const subagentIdleStop = () =>
  agyHook('Stop', { ...child, fullyIdle: true, terminationReason: 'NO_TOOL_CALL' })

it.each([
  ['after', false],
  ['before', true]
])(
  'ends the run on agy done that arrives %s its last subagent stops after the parent turn',
  async (_order, doneFirst) => {
    fakeTranscriptClock()
    await parentStopsWhileSubagentRuns()
    if (doneFirst) {
      programDone()
    }
    await subagentIdleStop()
    if (!doneFirst) {
      programDone()
    }
    expect(state()).toBe('working')

    await waitForSettledRoster([])
    expect(state()).toBe('working')
    await vi.advanceTimersByTimeAsync(ANTIGRAVITY_PARENT_WAKE_GRACE_MS - transcriptPollMs + 1)
    expect(state()).toBe('done')
  }
)

it("waits out the grace after a parent's busy Stop that lands after its subagent's", async () => {
  fakeTranscriptClock()
  await agyHook('PreInvocation', { transcriptPath: brainWithChildDescriptor() })
  await agyHook('PreToolUse', subagentCall)
  await agyHook('PostToolUse', subagentCall)
  await agyHook('PreInvocation', child)
  await waitForSettledRoster(['child'])
  await subagentIdleStop()
  await waitForSettledRoster([])
  await vi.advanceTimersByTimeAsync(ANTIGRAVITY_PARENT_WAKE_GRACE_MS)
  await agyHook('Stop', { fullyIdle: false, terminationReason: 'NO_TOOL_CALL' })
  programDone()
  expect(state()).toBe('working')

  await vi.advanceTimersByTimeAsync(ANTIGRAVITY_PARENT_WAKE_GRACE_MS + 1)
  expect(state()).toBe('done')
})

it("keeps the run working when agy's done lands while a sibling subagent still works", async () => {
  fakeTranscriptClock()
  await parentStopsWhileSubagentRuns(['child', 'sibling'])
  programDone()
  await subagentIdleStop()

  await waitForSettledRoster(['sibling'])
  await vi.advanceTimersByTimeAsync(ANTIGRAVITY_PARENT_WAKE_GRACE_MS * 2 - transcriptPollMs)
  expect(state()).toBe('working')
  expect(server.getStatusSnapshot()[0]?.subagents?.map(({ id }) => id)).toEqual(['sibling'])
  await agyHook('Stop', { ...child, conversationId: 'sibling', fullyIdle: true })
  await waitForSettledRoster([])
  expect(state()).toBe('working')
  await vi.advanceTimersByTimeAsync(ANTIGRAVITY_PARENT_WAKE_GRACE_MS - transcriptPollMs + 1)
  expect(state()).toBe('done')
})

it('discards an earlier refused done when a new root prompt opens', async () => {
  await parentStopsWhileSubagentRuns()
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  programDone()
  await vi.advanceTimersByTimeAsync(4001)
  await agyHook('PreInvocation', { lastUserInput: 'a new task' })
  await subagentIdleStop()
  await vi.advanceTimersByTimeAsync(4001)
  expect(state()).toBe('working')
})

it('discards a refused done when the program reports new work', async () => {
  await parentStopsWhileSubagentRuns()
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  programDone()
  await vi.advanceTimersByTimeAsync(4001)
  server.ingestTerminalStatus({
    paneKey: PANE,
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    connectionId: null,
    fromProgramStatus: true,
    payload: { prompt: '', state: 'working', agentType: 'antigravity' }
  })
  await subagentIdleStop()
  await vi.advanceTimersByTimeAsync(4001)
  expect(state()).toBe('working')
})

it('ends the run on agy done when the finished subagent leaves the row during the grace', async () => {
  fakeTranscriptClock()
  await parentStopsWhileSubagentRuns()
  await subagentIdleStop()
  programDone()
  // The roster poll drops the finished child from the row before the grace ends.
  await waitForSettledRoster([])
  expect(server.getStatusSnapshot()[0]?.subagents).toBeUndefined()
  expect(state()).toBe('working')
  await vi.advanceTimersByTimeAsync(ANTIGRAVITY_PARENT_WAKE_GRACE_MS - transcriptPollMs + 1)
  expect(state()).toBe('done')
})

function brainWithChildDescriptor(ids = ['child'], includeResults = true): string {
  const brain = join(dir, 'brain', 'parent', '.system_generated')
  mkdirSync(join(brain, 'logs'), { recursive: true })
  mkdirSync(join(brain, 'subagents'), { recursive: true })
  const transcriptPath = join(brain, 'logs', 'transcript.jsonl')
  writeFileSync(
    transcriptPath,
    `${JSON.stringify({ source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'start the job' })}\n`
  )
  for (const [index, conversationId] of ids.entries()) {
    writeFileSync(
      join(brain, 'subagents', `${conversationId}.json`),
      JSON.stringify({ conversationId, state: 'SUBAGENT_STATE_ALIVE' })
    )
    if (includeResults) {
      appendInvokeResult(transcriptPath, index + 2, conversationId)
    }
  }
  return transcriptPath
}

function appendInvokeResult(transcriptPath: string, step: number, conversationId: string): void {
  appendFileSync(
    transcriptPath,
    `${JSON.stringify({
      step_index: step,
      type: 'GENERIC',
      source: 'MODEL',
      status: 'DONE',
      content: `Created the following subagent:\n${JSON.stringify({ conversationId })}\nThe subagent will send you a message when it has completed its task or requires guidance.`
    })}\n`
  )
}

it('recovers a root launch result before a large backlog and waits for the other launch', async () => {
  const transcriptPath = brainWithChildDescriptor(['C', 'sibling'], false)
  const root = { transcriptPath }
  await agyHook('PreInvocation', root)
  await agyHook('PreToolUse', { ...root, ...invoke(5) })
  await agyHook('PreToolUse', { ...root, ...invoke(6) })
  for (const conversationId of ['C', 'sibling']) {
    await agyHook('PreInvocation', { ...child, conversationId, modelName: 'child-model' })
  }
  const row = () => server.getStatusSnapshot()[0]
  await vi.waitFor(() => expect(row()?.subagents?.map(({ id }) => id)).toEqual(['C', 'sibling']), {
    timeout: 10000
  })

  appendInvokeResult(transcriptPath, 5, 'C')
  appendFileSync(
    transcriptPath,
    `${JSON.stringify({ type: 'PLANNER_RESPONSE', content: 'x'.repeat(1024) })}\n`.repeat(1100)
  )
  await agyHook('Stop', { ...root, fullyIdle: true })
  await agyHook('PostToolUse', { ...root, ...invoke(5) })
  programDone()
  expect(row()?.subagents?.map(({ id }) => id)).toEqual(['C', 'sibling'])
  await agyHook('Stop', { ...child, conversationId: 'C', fullyIdle: true })
  await vi.waitFor(
    () =>
      expect(row()).toMatchObject({
        state: 'working',
        antigravitySpawnPending: true,
        subagents: [{ id: 'sibling' }]
      }),
    { timeout: 10000 }
  )

  appendInvokeResult(transcriptPath, 6, 'sibling')
  await vi.waitFor(() => expect(row()?.antigravitySpawnPending).toBeUndefined(), { timeout: 10000 })
  expect(row()).toMatchObject({ state: 'working', subagents: [{ id: 'sibling' }] })
  await agyHook('Stop', { ...child, conversationId: 'sibling', fullyIdle: true })
  await vi.waitFor(() => expect(state()).toBe('done'), { timeout: 10000 })
})

it('keeps the run working while a second spawn has not produced its subagent', async () => {
  const transcriptPath = brainWithChildDescriptor()
  await agyHook('PreInvocation', { transcriptPath })
  await agyHook('PreToolUse', { ...subagentCall, transcriptPath })
  await agyHook('PreToolUse', { ...invoke(3), transcriptPath })
  await agyHook('PreInvocation', child)
  await agyHook('Stop', { fullyIdle: false, terminationReason: 'NO_TOOL_CALL', transcriptPath })
  await vi.waitFor(() => expect(server.getStatusSnapshot()[0]?.subagents).toHaveLength(1), {
    timeout: 10000
  })
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  await subagentIdleStop()
  programDone()
  await vi.advanceTimersByTimeAsync(HOOK_SILENCE_BEFORE_PROGRAM_STATUS_FALLBACK_MS + 1)
  expect(server.getStatusSnapshot()[0]?.antigravitySpawnPending).toBe(true)
  expect(state()).toBe('working')
})

it('ends the run on agy done after a subagent that finished before its first poll is proven', async () => {
  const transcriptPath = brainWithChildDescriptor()
  await agyHook('PreInvocation', { transcriptPath })
  await agyHook('PreToolUse', { ...subagentCall, transcriptPath })
  await agyHook('PreInvocation', child)
  await agyHook('Stop', { fullyIdle: false, terminationReason: 'NO_TOOL_CALL', transcriptPath })
  await subagentIdleStop()
  programDone()
  await vi.waitFor(() => expect(state()).toBe('done'), { timeout: 10000 })
})

it('keeps the subagent roster when agy reports working after a long hook-silent wait', async () => {
  await parentStopsWhileSubagentRuns()
  await agyHook('PreToolUse', { ...child, toolCall: { name: 'ask_question', args: {} } })
  await vi.waitFor(() => expect(state()).toBe('waiting'), { timeout: 10000 })
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  vi.advanceTimersByTime(HOOK_SILENCE_BEFORE_PROGRAM_STATUS_FALLBACK_MS + 1)
  server.ingestTerminalStatus({
    paneKey: PANE,
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    connectionId: null,
    fromProgramStatus: true,
    payload: { prompt: '', state: 'working', agentType: 'antigravity' }
  })
  expect(server.getStatusSnapshot()[0]?.subagents?.map((subagent) => subagent.id)).toEqual([
    'child'
  ])
})

it('keeps a woken subagent from settling a newer spawn', async () => {
  const transcriptPath = brainWithChildDescriptor()
  await agyHook('PreInvocation', { transcriptPath })
  await agyHook('PreToolUse', { ...subagentCall, transcriptPath })
  await agyHook('PreInvocation', child)
  await vi.waitFor(() => expect(server.getStatusSnapshot()[0]?.subagents).toHaveLength(1), {
    timeout: 10000
  })
  await subagentIdleStop()
  await agyHook('PreToolUse', { ...invoke(3), transcriptPath })
  await agyHook('Stop', { fullyIdle: false, terminationReason: 'NO_TOOL_CALL', transcriptPath })
  await agyHook('PreInvocation', child)
  await vi.waitFor(() => expect(server.getStatusSnapshot()[0]?.subagents).toHaveLength(1), {
    timeout: 10000
  })
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  await subagentIdleStop()
  programDone()
  await vi.advanceTimersByTimeAsync(HOOK_SILENCE_BEFORE_PROGRAM_STATUS_FALLBACK_MS + 1)
  expect(server.getStatusSnapshot()[0]?.antigravitySpawnPending).toBe(true)
  expect(state()).toBe('working')
})

it.each([
  ['reports a pending spawn', false],
  ['drops its roster to fit a frame', true]
])('holds a relayed done while the remote host %s', async (_case, shedRoster) => {
  const connectionId = 'ssh-agy'
  const leadStartedAt = Date.now()
  server.beginRemoteRelaySession(connectionId)
  const report = (ids: string[], spawnPending?: true, drained?: true): void => {
    const shed = shedRoster && spawnPending && ids.length === 0
    server.ingestRemote(
      {
        ...(shed ? { shedFields: [createShedSubagentsField([worker('b')])] } : {}),
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        source: 'antigravity',
        ...(drained ? { antigravityHelpersDrained: true, isReplay: true } : {}),
        providerSession: { key: 'conversation_id', id: 'remote-root' },
        agentPresence: { agent: 'antigravity', session: 'remote-root' },
        payload: {
          prompt: 'remote job',
          state: 'working',
          agentType: 'antigravity',
          mainAgent: { state: 'done', stateStartedAt: leadStartedAt },
          subagents: shed ? undefined : ids.map(worker),
          ...(spawnPending && !shed ? { antigravitySpawnPending: spawnPending } : {})
        }
      },
      connectionId
    )
  }
  report(['a'], true)
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  server.ingestTerminalStatus({
    paneKey: PANE,
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    connectionId,
    fromProgramStatus: true,
    payload: { prompt: '', state: 'done', agentType: 'antigravity' }
  })
  report([], true)
  await vi.advanceTimersByTimeAsync(HOOK_SILENCE_BEFORE_PROGRAM_STATUS_FALLBACK_MS + 1)
  if (!shedRoster) {
    expect(server.getStatusSnapshot()[0]?.antigravitySpawnPending).toBe(true)
  }
  expect(state()).toBe('working')
  report([], undefined, true)
  await vi.advanceTimersByTimeAsync(ANTIGRAVITY_PARENT_WAKE_GRACE_MS * 3)
  expect(state()).toBe('done')
})

it('holds an unreadable root launch past the discovery lease and clears it on process exit', async () => {
  const transcriptPath = join(dir, 'parent', '.system_generated', 'logs', 'transcript.jsonl')
  fakeTranscriptClock()
  await agyHook('PreInvocation', { transcriptPath, modelName: 'auto' })
  await agyHook('PreToolUse', {
    stepIdx: 1,
    toolCall: { name: 'run_command', args: { CommandLine: 'sleep 600' } }
  })
  await agyHook('PostToolUse', subagentCall)
  const question = {
    stepIdx: 3,
    toolCall: { id: 'question-3', name: 'ask_question', args: { question: 'Continue?' } }
  }
  await agyHook('PreToolUse', question)
  expect(state()).toBe('waiting')
  await agyHook('PreToolUse', {
    ...subagentCall,
    lastUserInput: 'earlier task',
    modelName: 'model-old'
  })
  programDone()
  await vi.advanceTimersByTimeAsync(HOOK_SILENCE_BEFORE_PROGRAM_STATUS_FALLBACK_MS + 1)
  expect(server.getStatusSnapshot()[0]).toMatchObject({
    state: 'waiting',
    toolName: 'ask_question',
    toolInput: 'Continue?'
  })

  await agyHook('PostToolUse', question)
  await agyHook('Stop', { fullyIdle: false })
  programDone()
  await vi.advanceTimersByTimeAsync(AGENT_STATUS_STALE_AFTER_MS + 60000)
  expect(server.getStatusSnapshot()[0]).toMatchObject({
    state: 'working',
    antigravitySpawnPending: true
  })
  await agyHook('Stop', { fullyIdle: true })
  expect(state()).toBe('working')
  server.reconcileEndedProcessForPaneKeys([PANE], { confirmedExit: true })
  expect(server.getStatusSnapshot()).toHaveLength(0)
})

it('holds a delayed original Post after launch history overflows until the root process exits', async () => {
  fakeTranscriptClock()
  const transcriptPath = brainWithChildDescriptor([])
  const root = { transcriptPath }
  const steps = Array.from({ length: 257 }, (_, index) => index + 2)
  await agyHook('PreInvocation', root)
  for (const step of steps) {
    await agyHook('PreToolUse', { ...root, ...invoke(step) })
  }
  const results = steps.map((step) =>
    JSON.stringify({
      step_index: step,
      type: 'GENERIC',
      source: 'MODEL',
      status: 'ERROR',
      content:
        'Encountered error in step execution: subagent "x" not found or not allowed to be invoked'
    })
  )
  appendFileSync(transcriptPath, `${results.join('\n')}\n`)
  await waitForSettledRoster([])
  await agyHook('Stop', { ...root, fullyIdle: true })
  expect(state()).toBe('done')

  await agyHook('PostToolUse', { ...root, ...invoke(2) })
  expect(server.getStatusSnapshot()[0]).toMatchObject({
    state: 'working',
    antigravitySpawnPending: true
  })
  await agyHook('Stop', { ...root, fullyIdle: true })
  programDone()
  await vi.advanceTimersByTimeAsync(AGENT_STATUS_STALE_AFTER_MS + 60000)
  expect(server.getStatusSnapshot()[0]).toMatchObject({
    state: 'working',
    antigravitySpawnPending: true
  })
  server.reconcileEndedProcessForPaneKeys([PANE], { confirmedExit: true })
  expect(server.getStatusSnapshot()).toHaveLength(0)
})

it('honors a replayed drain without the earlier roster and discards its completion on a newer turn', async () => {
  const connectionId = 'ssh-agy'
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  server.beginRemoteRelaySession(connectionId)
  const report = (root: string, drained: boolean, stateStartedAt = Date.now()) =>
    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        source: 'antigravity',
        providerSession: { key: 'conversation_id', id: root },
        agentPresence: { agent: 'antigravity', session: root },
        ...(drained
          ? { isReplay: true, antigravityHelpersDrained: true }
          : {
              hookEventName: 'PreInvocation',
              hasExplicitPrompt: true
            }),
        payload: {
          prompt: root,
          state: 'working',
          agentType: 'antigravity',
          mainAgent: { state: drained ? 'done' : 'working', stateStartedAt }
        }
      },
      connectionId
    )
  const done = () =>
    server.ingestTerminalStatus({
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      connectionId,
      fromProgramStatus: true,
      payload: { prompt: '', state: 'done', agentType: 'antigravity' }
    })
  report('first', true)
  done()
  expect(state()).toBe('working')
  await vi.advanceTimersByTimeAsync(2001)
  expect(state()).toBe('done')

  const previousTurn = Date.now()
  report('second', true, previousTurn)
  done()
  await vi.advanceTimersByTimeAsync(1)
  report('second', false)
  report('second', true, previousTurn)
  expect(server.getStatusSnapshot()[0]?.mainAgent?.state).toBe('working')
  await vi.advanceTimersByTimeAsync(2001)
  expect(state()).toBe('working')
})

it.each([
  ['', false],
  [' after a model-only poll', true]
])(
  'ends the run on agy done that arrived before a messaged subagent was proven%s',
  async (_case, modelPoll) => {
    const transcriptPath = brainWithChildDescriptor()
    const message = { stepIdx: 2, toolCall: { name: 'send_message', args: {} }, transcriptPath }
    await agyHook('PreInvocation', { transcriptPath, modelName: 'auto' })
    await agyHook('PreToolUse', message)
    await agyHook('PostToolUse', message)
    await agyHook('Stop', { fullyIdle: false, terminationReason: 'NO_TOOL_CALL', transcriptPath })
    programDone()
    if (modelPoll) {
      appendFileSync(
        transcriptPath,
        `${JSON.stringify({ type: 'PLANNER_RESPONSE', model: 'model-x', created_at: '2999-01-01T00:00:00Z' })}\n`
      )
      await vi.waitFor(() => expect(server.getStatusSnapshot()[0]?.model).toBe('model-x'), {
        timeout: 10000
      })
    }
    await agyHook('PreInvocation', child)
    await vi.waitFor(() => expect(server.getStatusSnapshot()[0]?.subagents).toHaveLength(1), {
      timeout: 10000
    })
    await subagentIdleStop()
    await vi.waitFor(() => expect(state()).toBe('done'), { timeout: 10000 })
  }
)
