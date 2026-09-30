// A Claude background workflow is live work from the tool call that launches it, like a background
// shell. These stories replay hook payloads recorded from Claude Code 2.1.285 over a real PTY
// (src/shared/__fixtures__/claude-background-workflow-*-hooks.jsonl, sidecars beside them). The
// captured scripts run their agents one after another, so between them, and before the first, no
// agent holds the pane: after a Ctrl+C in the launch turn only the workflow's own record does.
// Claude writes a completed workflow's end as the same `queue-operation` line a shell gets.
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentHookServer } from './server'
import { _internals } from './server'
import { PANE } from './server.test-fixtures'
import {
  cancelLabelled,
  hookAt,
  hookSupersedesCancel,
  loadCapture,
  type CapturedRecord
} from './claude-cancel-capture.test-fixture'
import {
  captureEpoch,
  cleanUpCaptureReplays,
  pressCtrlC,
  queueLine,
  replayer,
  row,
  startServer,
  temporaryDir,
  transcriptFile,
  watchCaughtUp,
  writeCaptured
} from './claude-background-task-capture.test-fixture'

const { getCohortAtEmitMock, trackMock } = vi.hoisted(() => ({
  getCohortAtEmitMock: vi.fn(),
  trackMock: vi.fn()
}))

vi.mock('../telemetry/client', () => ({ track: trackMock }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: getCohortAtEmitMock }))

beforeEach(() => {
  _internals.resetCachesForTests()
  trackMock.mockReset()
  getCohortAtEmitMock.mockReset()
  getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
  // Why: rows and the cancel latch read Date.now(); watch ticks stay on real timers.
  vi.useFakeTimers({ toFake: ['Date'] })
})

afterEach(() => {
  cleanUpCaptureReplays()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function recordedTasks(server: AgentHookServer) {
  return server._getStateForTests().claudeNonAgentWorkByPaneKey.get(PANE)?.tasks
}

function rosterSize(server: AgentHookServer): number {
  return server._getStateForTests().claudeSubagentRosterByPaneKey.get(PANE)?.size ?? 0
}

function keyAt(records: CapturedRecord[], label: string): number {
  const key = records.find((record) => record.kind === 'key' && record.label === label)
  if (!key) {
    throw new Error(`Captured key ${label} not found`)
  }
  return key.t
}

const MONITORING = { state: 'working', workingMode: 'monitoring' } as const
const CANCELLED = { mainAgent: { state: 'done', outcome: 'cancellation' } } as const

// W8, the case this change is for: after a Ctrl+C in the launch turn nothing but the workflow's own
// record says it runs while its script waits between agents.
describe('Ctrl+C in the turn that launched a workflow whose script waits between agents (captured, 2.1.285)', () => {
  const records = loadCapture('claude-background-workflow-script-wait-ctrl-c-hooks')
  const cancel = cancelLabelled(records, 'W8-ctrl-c-after-launch')
  const notice = queueLine(records, 'interrupt-notice')
  const completed = queueLine(records, 'queue-operation-enqueue')

  it('monitors through the 60 s wait with no agent, instead of reading done', async () => {
    const server = await startServer()
    const transcript = transcriptFile()
    const replay = replayer(server, records, new Map([['*', transcript]]))
    // Hook order by the capture's clock: the launch result lands 11 ms before agent 1 starts.
    await replay([0, 1, 2, 4, 3, 5])

    // The capture: no hook inside the renderer's settle window, so it infers the Ctrl+C.
    expect(cancel).toMatchObject({ interrupted_painted: true })
    expect(hookSupersedesCancel(records, cancel)).toBe(false)
    vi.setSystemTime(captureEpoch(records) + cancel.t * 1000)
    expect(pressCtrlC(server)).toBe(true)
    appendFileSync(transcript, `${notice.lines[0]}\n`)
    await replay([6, 7, 8])
    expect(row(server)).toMatchObject({ state: 'working', ...CANCELLED })

    // Agent 1 stops; agent 2 starts 60.1 s later, with no hook or main-transcript line between.
    await replay([9])
    expect(rosterSize(server)).toBe(0)
    expect(row(server)).toMatchObject({ ...MONITORING, ...CANCELLED })
    expect(row(server).interrupted).toBeUndefined()
    expect(hookAt(records, 10).t - hookAt(records, 9).t).toBeGreaterThan(60)
    vi.setSystemTime(captureEpoch(records) + (hookAt(records, 10).t - 1) * 1000)
    // Hand-built: a line no reason reads, so a caught-up offset proves a tick ran late in the wait.
    appendFileSync(transcript, '{"type":"mode"}\n')
    await watchCaughtUp(server, transcript)
    expect(row(server)).toMatchObject({ ...MONITORING, ...CANCELLED })

    await replay([10, 11])
    expect(row(server)).toMatchObject({ state: 'working', ...CANCELLED })
    expect(row(server).workingMode).not.toBe('monitoring')
    await replay([12, 13, 14])
    expect(row(server)).toMatchObject({ ...MONITORING, ...CANCELLED })

    // By Claude's own stamps the end line (18:43:23.636Z) precedes the report turn's prompt hook
    // by 41 ms.
    writeCaptured(records, completed, transcript)
    await vi.waitFor(() => expect(row(server).state).toBe('done'), { timeout: 3_000 })
    expect(row(server)).toMatchObject({ interrupted: true, ...CANCELLED })
    expect(recordedTasks(server)).toBeUndefined()
    await replay([15])
    expect(row(server)).toMatchObject({ state: 'working', mainAgent: { state: 'working' } })
    await replay([16, 17, 18])
    expect(row(server)).toMatchObject({ state: 'done', mainAgent: { state: 'done' } })
  })
})

describe('Ctrl+C in the turn that launched a background workflow (captured, 2.1.285)', () => {
  const records = loadCapture('claude-background-workflow-ctrl-c-hooks')
  const cancel = cancelLabelled(records, 'W2-ctrl-c-mid-essay')
  const notice = queueLine(records, 'interrupt-notice')
  const completed = queueLine(records, 'queue-operation-enqueue')

  it('keeps the pane live after its agent stops, until the line Claude writes when it ends', async () => {
    const server = await startServer()
    const transcript = transcriptFile()
    const replay = replayer(server, records, new Map([['*', transcript]]))
    await replay([0, 1, 2, 3])
    // The launch names the workflow by `taskId`; there is no `backgroundTaskId`.
    expect(hookAt(records, 3).payload.tool_response).toMatchObject({
      status: 'async_launched',
      taskId: 'wuxzs3s3c',
      taskType: 'local_workflow'
    })
    await replay([4, 5, 6, 7, 8])
    expect(row(server)).toMatchObject({ state: 'working', mainAgent: { state: 'working' } })

    // The capture: Claude painted "Interrupted", wrote its notice, and sent no hook for 32 s.
    expect(cancel).toMatchObject({ interrupted_painted: true, hooks_before_next_typed_prompt: [] })
    vi.setSystemTime(captureEpoch(records) + cancel.t * 1000)
    expect(pressCtrlC(server)).toBe(true)
    expect(row(server)).toMatchObject({ state: 'working', ...CANCELLED })
    appendFileSync(transcript, `${notice.lines[0]}\n`)
    await watchCaughtUp(server, transcript)
    expect(row(server)).toMatchObject({ state: 'working', ...CANCELLED })

    // Its agent's late hooks carry the cancelled turn's prompt id and change only the child work.
    expect(hookAt(records, 9).payload.prompt_id).toBe(hookAt(records, 1).payload.prompt_id)
    await replay([9, 10])
    expect(row(server)).toMatchObject({ state: 'working', ...CANCELLED })
    await replay([11])
    expect(rosterSize(server)).toBe(0)
    expect(row(server)).toMatchObject({ ...MONITORING, ...CANCELLED })
    expect(row(server).interrupted).toBeUndefined()

    writeCaptured(records, completed, transcript)
    await vi.waitFor(() => expect(row(server).state).toBe('done'), { timeout: 3_000 })
    expect(row(server)).toMatchObject({ interrupted: true, ...CANCELLED })
    expect(recordedTasks(server)).toBeUndefined()

    // The report turn is a turn of its own.
    await replay([12])
    expect(row(server)).toMatchObject({ state: 'working', mainAgent: { state: 'working' } })
    await replay([13, 14])
    expect(row(server)).toMatchObject({ state: 'done', mainAgent: { state: 'done' } })
  })
})

describe('a background workflow run to completion (captured, 2.1.285)', () => {
  const records = loadCapture('claude-background-workflow-completed-hooks')
  const completed = queueLine(records, 'queue-operation-enqueue')

  it('settles on its end line before the report turn opens, as the launch turn, with no second completion', async () => {
    const server = await startServer()
    const transcript = transcriptFile()
    const replay = replayer(server, records, new Map([['*', transcript]]))
    await replay([0, 1, 2, 3])
    await replay([4, 5, 6, 7])
    // The launch turn's Stop lists it by the inventory's name for a workflow.
    expect(hookAt(records, 7).payload.background_tasks).toEqual([
      expect.objectContaining({ id: 'w1kuktaid', type: 'workflow', status: 'running' })
    ])
    const settled = row(server)
    expect(settled).toMatchObject({ ...MONITORING, mainAgent: { state: 'done' } })
    expect(typeof settled.turnCompletedAt).toBe('number')

    await replay([8, 9, 10, 11])
    expect(row(server)).toMatchObject({ ...MONITORING, mainAgent: { state: 'done' } })

    // The capture's write order, by Claude's own stamps: the end line 17:00:28.690Z, the report
    // turn's UserPromptSubmit 41 ms later (the fixture `t` of a line is the rig's poll time).
    writeCaptured(records, completed, transcript)
    await vi.waitFor(() => expect(row(server).state).toBe('done'), { timeout: 3_000 })
    expect(row(server)).toMatchObject({ mainAgent: { state: 'done' } })
    expect(row(server).interrupted).toBeUndefined()
    // Why: the settled row repeats the Stop's turn stamp, which is how a completion is paired.
    expect(row(server).turnCompletedAt).toBe(settled.turnCompletedAt)

    await replay([12])
    expect(row(server)).toMatchObject({ state: 'working', mainAgent: { state: 'working' } })
    await replay([13, 14])
    expect(row(server)).toMatchObject({ state: 'done', mainAgent: { state: 'done' } })
    expect(row(server).turnCompletedAt).not.toBe(settled.turnCompletedAt)
  })
})

describe('/clear while a background workflow runs (captured, 2.1.285)', () => {
  const records = loadCapture('claude-background-workflow-clear-hooks')
  const completed = queueLine(records, 'queue-operation-enqueue')

  it('keeps the workflow across the session change and settles on its end line in the new transcript', async () => {
    const server = await startServer()
    const dir = temporaryDir()
    const first = join(dir, 'first.jsonl')
    const cleared = join(dir, 'cleared.jsonl')
    writeFileSync(first, '')
    const files = new Map([
      [String(hookAt(records, 0).payload.transcript_path), first],
      [String(hookAt(records, 10).payload.transcript_path), cleared]
    ])
    expect(files.size).toBe(2)
    const replay = replayer(server, records, files)
    await replay([0, 1, 2, 3, 4, 5, 6, 7, 8])
    const beforeClear = row(server)
    expect(beforeClear).toMatchObject({ state: 'working', mainAgent: { state: 'done' } })
    expect(typeof beforeClear.turnCompletedAt).toBe('number')

    expect(hookAt(records, 10).payload).toMatchObject({
      hook_event_name: 'SessionStart',
      source: 'clear'
    })
    await replay([9, 10])
    expect(row(server)).toMatchObject({ ...MONITORING, mainAgent: { state: 'done' } })
    expect(row(server).turnCompletedAt).toBe(beforeClear.turnCompletedAt)
    expect(recordedTasks(server)?.has('wvdcggdcr')).toBe(true)
    // Hand-built: stands for the new file's first rows, which the fixture does not keep.
    writeFileSync(cleared, '{"type":"mode"}\n')

    // The agent's later hooks carry the new session id and no prompt id.
    expect(hookAt(records, 11).payload.session_id).toBe(hookAt(records, 10).payload.session_id)
    expect(hookAt(records, 11).payload).not.toHaveProperty('prompt_id')
    await replay([11, 12, 13])
    expect(row(server)).toMatchObject({ ...MONITORING, mainAgent: { state: 'done' } })

    // The capture's write order, by Claude's own stamps: the end line 17:09:27.467Z, the report
    // turn's UserPromptSubmit 42 ms later.
    expect(completed.file).toBe(
      String(hookAt(records, 10).payload.transcript_path).split('/').pop()
    )
    appendFileSync(cleared, `${completed.lines[0]}\n`)
    await vi.waitFor(() => expect(row(server).state).toBe('done'), { timeout: 3_000 })
    expect(row(server).turnCompletedAt).toBe(beforeClear.turnCompletedAt)

    await replay([14, 15, 16])
    expect(row(server)).toMatchObject({ state: 'done', mainAgent: { state: 'done' } })
  })
})

// Temporary: a workflow stopped from /tasks writes no end line (r6-w3), unlike a shell. Flip this
// story to expect `done` at that line once a capture shows Claude writing a killed row for one.
describe('a background workflow stopped from /tasks (captured, 2.1.285)', () => {
  const records = loadCapture('claude-background-workflow-tasks-kill-hooks')
  // Why: the capture kept no transcript line to anchor the clock; only order matters here.
  const t0 = Date.parse('2026-09-30T17:03:48.000Z')

  it('stays live until Claude next lists its tasks: no hook reports its end, and no timer may', async () => {
    const server = await startServer()
    const transcript = transcriptFile()
    const replay = replayer(server, records, new Map([['*', transcript]]), t0)
    await replay([0, 1, 2, 3, 4, 5, 6, 7, 8])
    expect(row(server)).toMatchObject({ state: 'working', mainAgent: { state: 'done' } })

    // The capture: after `x`, no hook, not even SubagentStop, and nothing in the main transcript
    // until the next typed prompt 135 s later. The workflow's agent stays on the roster too.
    const stopped = keyAt(records, 'W3-x-stop-workflow')
    expect(
      records.some(
        (record) => record.kind !== 'key' && record.t > stopped && record.t < hookAt(records, 9).t
      )
    ).toBe(false)
    vi.setSystemTime(t0 + (hookAt(records, 9).t - 1) * 1000)
    // Hand-built: a line no reason reads, so a caught-up offset proves a tick ran at that time.
    appendFileSync(transcript, '{"type":"mode"}\n')
    await watchCaughtUp(server, transcript)
    expect(row(server)).toMatchObject({ state: 'working', mainAgent: { state: 'done' } })
    expect(recordedTasks(server)?.has('wc6rxzj9v')).toBe(true)

    await replay([9, 10])
    expect(hookAt(records, 10).payload.background_tasks).toEqual([])
    expect(row(server)).toMatchObject({ state: 'done', mainAgent: { state: 'done' } })
    expect(recordedTasks(server)).toBeUndefined()
    expect(rosterSize(server)).toBe(0)
  })
})

describe('a background workflow whose script waits between two agents (captured, 2.1.285)', () => {
  const records = loadCapture('claude-background-workflow-script-wait-hooks')
  const completed = queueLine(records, 'queue-operation-enqueue')

  it('monitors through the wait after a normal launch turn, then settles on its end line', async () => {
    const server = await startServer()
    const transcript = transcriptFile()
    const replay = replayer(server, records, new Map([['*', transcript]]))
    await replay([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
    expect(row(server)).toMatchObject({ ...MONITORING, mainAgent: { state: 'done' } })

    // The capture: 20.1 s from agent 1's SubagentStop to agent 2's SubagentStart, with no hook and
    // no main-transcript line between them.
    expect(hookAt(records, 12).t - hookAt(records, 11).t).toBeGreaterThan(20)
    await replay([12, 13])
    expect(row(server)).toMatchObject({ state: 'working', mainAgent: { state: 'done' } })
    expect(row(server).workingMode).not.toBe('monitoring')
    await replay([14, 15, 16])
    expect(row(server)).toMatchObject({ ...MONITORING, mainAgent: { state: 'done' } })

    // By Claude's own stamps the end line (18:06:08.108Z) precedes the report turn's prompt hook
    // by 40 ms; the fixture's `t` for the line is the rig's later poll time.
    writeCaptured(records, completed, transcript)
    await vi.waitFor(() => expect(row(server).state).toBe('done'), { timeout: 3_000 })
    await replay([17, 18])
    expect(row(server)).toMatchObject({ state: 'done', mainAgent: { state: 'done' } })
  })
})

// Temporary, with the /tasks stop above: a pause kills the running agent with no SubagentStop and
// writes no end line, so the roster's agent holds the pane until the next inventory.
describe('a background workflow paused from /tasks (captured, 2.1.285)', () => {
  const records = loadCapture('claude-background-workflow-pause-hooks')
  const t0 = Date.parse('2026-09-30T18:12:28.000Z')

  it('reads working until the next typed turn lists no task, then done', async () => {
    const server = await startServer()
    const transcript = transcriptFile()
    const replay = replayer(server, records, new Map([['*', transcript]]), t0)
    await replay([0, 1, 2, 3, 4, 5, 6, 7, 8])
    const paused = keyAt(records, 'W6B-p-pause')
    expect(
      records.some(
        (record) => record.kind !== 'key' && record.t > paused && record.t < hookAt(records, 9).t
      )
    ).toBe(false)
    vi.setSystemTime(t0 + (hookAt(records, 9).t - 1) * 1000)
    appendFileSync(transcript, '{"type":"mode"}\n')
    await watchCaughtUp(server, transcript)
    expect(row(server)).toMatchObject({ state: 'working', mainAgent: { state: 'done' } })
    expect(rosterSize(server)).toBe(1)
    expect(recordedTasks(server)?.has('wmucfg2gk')).toBe(true)

    await replay([9, 10, 11])
    expect(hookAt(records, 11).payload.background_tasks).toEqual([])
    expect(row(server)).toMatchObject({ state: 'done', mainAgent: { state: 'done' } })
    expect(recordedTasks(server)).toBeUndefined()
    expect(rosterSize(server)).toBe(0)
  })
})

describe('an idle-prompt Ctrl+C while a background workflow runs (captured, 2.1.285)', () => {
  const records = loadCapture('claude-background-workflow-idle-ctrl-c-hooks')
  const cancel = cancelLabelled(records, 'W5A-ctrl-c-1')
  const completed = queueLine(records, 'queue-operation-enqueue')

  it('changes nothing: the workflow runs on and settles on its end line', async () => {
    const server = await startServer()
    const transcript = transcriptFile()
    const replay = replayer(server, records, new Map([['*', transcript]]))
    await replay([0, 1, 2, 3, 4, 5, 6, 7, 8])
    const idle = row(server)
    expect(idle).toMatchObject({ state: 'working', mainAgent: { state: 'done' } })

    // The capture: Claude painted only its exit hint; no row, no hook, and the sleep ran on.
    expect(cancel).toMatchObject({
      interrupted_painted: false,
      exit_hint_painted: true,
      hooks_before_next_typed_prompt: []
    })
    vi.setSystemTime(captureEpoch(records) + cancel.t * 1000)
    expect(pressCtrlC(server)).toBe(false)
    expect(row(server)).toEqual(idle)

    await replay([9, 10, 11])
    expect(row(server)).toMatchObject({ ...MONITORING, mainAgent: { state: 'done' } })
    writeCaptured(records, completed, transcript)
    await vi.waitFor(() => expect(row(server).state).toBe('done'), { timeout: 3_000 })
    expect(row(server)).toMatchObject({ mainAgent: { state: 'done' } })
    expect(row(server).turnCompletedAt).toBe(idle.turnCompletedAt)
  })
})
