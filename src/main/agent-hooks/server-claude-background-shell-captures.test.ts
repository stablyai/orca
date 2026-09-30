// A Claude background shell is live work from the tool call that starts it. These stories replay
// hook payloads recorded from Claude Code 2.1.284/2.1.285 over a real PTY
// (src/shared/__fixtures__/claude-background-shell-*-hooks.jsonl, sidecars beside them) through the
// server's own HTTP ingress, with each hook's `transcript_path` pointed at a temp file. The only
// record of a task ending with no hook (a Ctrl+C'd turn's shell, a /tasks kill) is the
// `queue-operation` line Claude appends to its transcript; the stories append the captured line
// where it was written and let the listener's transcript watch find it on a real tick.
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _internals } from './server'
import { buildBody, PANE, postHookEvent } from './server.test-fixtures'
import { cancelLabelled, hookAt, loadCapture } from './claude-cancel-capture.test-fixture'
import {
  captureEpoch,
  cleanUpCaptureReplays,
  pressCtrlC,
  queueLine,
  replayer,
  row,
  startServer,
  storedTaskFact,
  temporaryDir,
  transcriptFile,
  watch,
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

describe('Ctrl+C in the turn that launched a background shell (captured, 2.1.284)', () => {
  const records = loadCapture('claude-background-shell-ctrl-c-hooks')
  const cancel = cancelLabelled(records, 'S1-ctrl-c-mid-essay')
  const killedAtExit = queueLine(records, 'queue-operation-enqueue')

  it('keeps the pane monitoring while the shell runs, then settles on the line Claude writes when it ends', async () => {
    const server = await startServer()
    const transcript = transcriptFile()
    const replay = replayer(server, records, new Map([['*', transcript]]))
    await replay([0, 1, 2, 3, 4, 5, 6])
    // The launching PostToolUse names the shell; the turn is still writing its reply.
    expect(hookAt(records, 3).payload.tool_response).toMatchObject({
      backgroundTaskId: 'b19zrx6gz'
    })
    expect(row(server)).toMatchObject({ state: 'working', mainAgent: { state: 'working' } })

    // The capture: Claude painted "Interrupted", sent no hook for 20 s, and kept the shell.
    expect(cancel).toMatchObject({ interrupted_painted: true, hooks_before_next_typed_prompt: [] })
    expect(hookAt(records, 7).sleep_procs).toEqual([expect.stringContaining('sleep 601')])
    vi.setSystemTime(captureEpoch(records) + cancel.t * 1000)
    expect(pressCtrlC(server)).toBe(true)
    expect(row(server)).toMatchObject({
      state: 'working',
      workingMode: 'monitoring',
      mainAgent: { state: 'done', outcome: 'cancellation' }
    })
    expect(row(server).interrupted).toBeUndefined()
    expect(storedTaskFact(server)).toBe(true)

    // The next typed turn's Stop lists the same shell running.
    await replay([7, 9, 8])
    expect(hookAt(records, 9).payload.background_tasks).toEqual([
      expect.objectContaining({ id: 'b19zrx6gz', status: 'running' })
    ])
    expect(row(server)).toMatchObject({
      state: 'working',
      workingMode: 'monitoring',
      mainAgent: { state: 'done' }
    })

    // /exit kills it: Claude writes the task's end line before SessionEnd.
    writeCaptured(records, killedAtExit, transcript)
    await vi.waitFor(() => expect(row(server).state).toBe('done'), { timeout: 3_000 })
    expect(row(server).workingMode).toBeUndefined()
    expect(storedTaskFact(server)).toBe(false)
  })

  it('retires the shell only on a line naming both its task id and its launching call', async () => {
    const server = await startServer()
    const transcript = transcriptFile()
    await replayer(server, records, new Map([['*', transcript]]))([0, 1, 2, 3, 4, 5, 6])
    vi.setSystemTime(captureEpoch(records) + cancel.t * 1000)
    expect(pressCtrlC(server)).toBe(true)
    const monitoring = row(server)

    // Captured (r3-typed-run1): a prompt typed while Claude is busy writes the same kind of line,
    // with only the typed text. Hand-built from the captured end line: the same notification
    // naming another launch, and one naming another task.
    const typed = queueLine(
      loadCapture('claude-background-shell-typed-while-busy-hooks'),
      'queue-operation-enqueue'
    ).lines[0]
    const matched = killedAtExit.lines[0]
    expect(matched).toContain('toolu_019ZC4zZwYU1rd1dxrk5uMzJ')
    appendFileSync(transcript, `${typed}\n`)
    appendFileSync(
      transcript,
      `${matched.replace('toolu_019ZC4zZwYU1rd1dxrk5uMzJ', 'toolu_01AAAAAAAAAAAAAAAAAAAAAA')}\n`
    )
    appendFileSync(transcript, `${matched.replaceAll('b19zrx6gz', 'bzzzzzzzz')}\n`)
    await watchCaughtUp(server, transcript)
    expect(row(server)).toEqual(monitoring)

    appendFileSync(transcript, `${matched}\n`)
    await vi.waitFor(() => expect(row(server).state).toBe('done'), { timeout: 3_000 })
    expect(row(server)).toMatchObject({
      interrupted: true,
      mainAgent: { state: 'done', outcome: 'cancellation' }
    })
  })
})

describe('a launch whose hook is still in flight at the Ctrl+C (captured hooks, hand-placed order)', () => {
  const records = loadCapture('claude-background-shell-ctrl-c-hooks')
  const cancel = cancelLabelled(records, 'S1-ctrl-c-mid-essay')

  it('records the shell although the cancel latch holds the row, so the next cancelled turn monitors it', async () => {
    const server = await startServer()
    const transcript = transcriptFile()
    const replay = replayer(server, records, new Map([['*', transcript]]))
    await replay([0, 1, 2])
    vi.setSystemTime(captureEpoch(records) + cancel.t * 1000)
    expect(pressCtrlC(server)).toBe(true)
    const cancelled = row(server)
    expect(cancelled).toMatchObject({ state: 'done', interrupted: true })
    // Hand-placed: the launching PostToolUse lands after the inferred cancel (no capture has one).
    await postHookEvent(
      server,
      buildBody({ ...hookAt(records, 3).payload, transcript_path: transcript })
    )
    expect(row(server)).toEqual(cancelled)
    expect(server._getStateForTests().claudeNonAgentWorkByPaneKey.has(PANE)).toBe(true)

    // The next typed turn is cancelled before its Stop: the shell still holds the pane.
    await replay([7])
    vi.setSystemTime(Date.now() + 1_000)
    expect(pressCtrlC(server)).toBe(true)
    expect(row(server)).toMatchObject({
      state: 'working',
      workingMode: 'monitoring',
      mainAgent: { state: 'done', outcome: 'cancellation' }
    })
  })
})

describe('a shell that ends before Orca handles its launch hook (captured hooks, hand-placed end line)', () => {
  const records = loadCapture('claude-background-shell-ctrl-c-hooks')
  const cancel = cancelLabelled(records, 'S1-ctrl-c-mid-essay')
  const killedAtExit = queueLine(records, 'queue-operation-enqueue')

  it('reads its end line from before the launch, so a Ctrl+C in that turn settles done', async () => {
    const server = await startServer()
    const transcript = transcriptFile()
    const replay = replayer(server, records, new Map([['*', transcript]]))
    await replay([0, 1, 2])
    // Hand-placed: the command ended within the hook's delivery latency (no capture has one).
    appendFileSync(
      transcript,
      `${killedAtExit.lines[0].replace('<status>killed</status>', '<status>failed</status>')}\n`
    )
    await replay([3, 4, 5, 6])
    vi.setSystemTime(captureEpoch(records) + cancel.t * 1000)
    expect(pressCtrlC(server)).toBe(true)
    expect(row(server)).toMatchObject({
      state: 'done',
      interrupted: true,
      mainAgent: { state: 'done', outcome: 'cancellation' }
    })
    expect(server._getStateForTests().claudeNonAgentWorkByPaneKey.has(PANE)).toBe(false)
  })
})

describe('a /tasks kill while Claude idles (captured, 2.1.284)', () => {
  const records = loadCapture('claude-background-shell-tasks-kill-idle-hooks')
  const killed = queueLine(records, 'queue-operation-enqueue')

  it('settles the pane within about a second, as the same turn, with no second completion', async () => {
    const server = await startServer()
    const transcript = transcriptFile()
    const replay = replayer(server, records, new Map([['*', transcript]]))
    await replay([0, 1, 2, 3, 4, 6, 5])
    const settled = row(server)
    expect(settled).toMatchObject({
      state: 'working',
      workingMode: 'monitoring',
      mainAgent: { state: 'done' }
    })
    expect(typeof settled.turnCompletedAt).toBe('number')

    // The capture: no hook for 20 s after the key, and no turn for 65 s.
    const key = records.find(
      (record) => record.kind === 'key' && record.label === 'S9-tasks-x-stop'
    )
    expect(key?.t).toBeLessThan(killed.t)
    expect(
      records.some((record) => record.kind === 'hook' && record.t > killed.t && record.t < 141)
    ).toBe(false)
    writeCaptured(records, killed, transcript)
    const written = performance.now()
    await vi.waitFor(() => expect(row(server).state).toBe('done'), { timeout: 3_000 })
    expect(performance.now() - written).toBeLessThan(2_000)
    expect(row(server)).toMatchObject({ mainAgent: { state: 'done' } })
    expect(row(server).mainAgent).not.toHaveProperty('outcome')
    expect(row(server).interrupted).toBeUndefined()
    // Why: the settled row repeats the Stop's turn stamp, which is how a completion is paired.
    expect(row(server).turnCompletedAt).toBe(settled.turnCompletedAt)

    // The next typed turn absorbs the notification and ends with an empty inventory.
    await replay([7])
    appendFileSync(transcript, `${queueLine(records, 'queue-operation-remove').lines[0]}\n`)
    await replay([9, 8])
    expect(hookAt(records, 8).payload.background_tasks).toEqual([])
    expect(row(server)).toMatchObject({ state: 'done', mainAgent: { state: 'done' } })
  })
})

describe('a /tasks kill during a running turn (captured, 2.1.285)', () => {
  const records = loadCapture('claude-background-shell-tasks-kill-busy-hooks')

  it('drops the shell from the working row at once, with no hook', async () => {
    const server = await startServer()
    const transcript = transcriptFile()
    const replay = replayer(server, records, new Map([['*', transcript]]))
    await replay([0, 1, 2, 3, 4, 5, 6, 7, 8])
    expect(row(server)).toMatchObject({ state: 'working', mainAgent: { state: 'working' } })
    expect(storedTaskFact(server)).toBe(true)

    writeCaptured(records, queueLine(records, 'queue-operation-enqueue'), transcript)
    await vi.waitFor(() => expect(storedTaskFact(server)).toBe(false), { timeout: 3_000 })
    expect(row(server)).toMatchObject({ state: 'working', mainAgent: { state: 'working' } })

    // 40 s later the turn's next tool boundary absorbs the notification, and its Stop lists nothing.
    await replay([9, 10, 11])
    appendFileSync(transcript, `${queueLine(records, 'queue-operation-remove').lines[0]}\n`)
    await replay([13, 12])
    expect(row(server)).toMatchObject({ state: 'done', mainAgent: { state: 'done' } })
  })
})

describe('/clear while a background shell runs (captured, 2.1.285)', () => {
  const records = loadCapture('claude-background-shell-clear-hooks')
  const completed = queueLine(records, 'queue-operation-enqueue')

  /** Replays up to the /clear, and checks the shell is kept across the session change. */
  async function clearedWithShell() {
    const server = await startServer()
    const dir = temporaryDir()
    const first = join(dir, 'first.jsonl')
    const cleared = join(dir, 'cleared.jsonl')
    writeFileSync(first, '')
    const files = new Map([
      [String(hookAt(records, 0).payload.transcript_path), first],
      [String(hookAt(records, 8).payload.transcript_path), cleared]
    ])
    expect(files.size).toBe(2)
    const replay = replayer(server, records, files)
    await replay([0, 1, 2, 3, 4, 5, 6])
    const monitoring = row(server)
    expect(monitoring).toMatchObject({ state: 'working', workingMode: 'monitoring' })
    expect(typeof monitoring.turnCompletedAt).toBe('number')

    // SessionEnd (clear), then SessionStart (clear) for a new session whose file Claude creates
    // 0.09 s after the hook. The capture: the shell was still running 28 s later.
    expect(hookAt(records, 8).payload).toMatchObject({
      hook_event_name: 'SessionStart',
      source: 'clear'
    })
    expect(hookAt(records, 8).sleep_procs).toEqual([expect.stringContaining('sleep 40.07')])
    await replay([7, 8])
    expect(row(server)).toMatchObject({
      state: 'working',
      workingMode: 'monitoring',
      mainAgent: { state: 'done' }
    })
    // Still the tail of the last turn that ended, so the shell's end is not a new turn.
    expect(row(server).turnCompletedAt).toBe(monitoring.turnCompletedAt)
    expect(watch(server)).toMatchObject({ filePath: cleared, awaitingFile: true })

    // Hand-built: stands for the new file's first rows, which the fixture does not keep.
    writeFileSync(cleared, '{"type":"mode"}\n')
    expect(completed.file).toBe(String(hookAt(records, 8).payload.transcript_path).split('/').pop())
    return { server, cleared, replay, monitoring }
  }

  // The capture's write order: the end line is stamped 07:51:30.885Z, and the notification turn's
  // UserPromptSubmit hook (started 30.951Z) read the file at 6233 bytes, the end of the enqueue and
  // dequeue lines. The fixture's `t` for a transcript line is the rig's later poll time.
  it('settles on the end line in the new transcript before the notification turn opens', async () => {
    const { server, cleared, replay, monitoring } = await clearedWithShell()
    appendFileSync(cleared, `${completed.lines[0]}\n`)
    await vi.waitFor(() => expect(row(server).state).toBe('done'), { timeout: 3_000 })
    expect(row(server)).toMatchObject({ mainAgent: { state: 'done' } })
    expect(row(server).turnCompletedAt).toBe(monitoring.turnCompletedAt)

    await replay([9])
    expect(row(server)).toMatchObject({ state: 'working', mainAgent: { state: 'working' } })
    await replay([10])
    expect(row(server)).toMatchObject({ state: 'done', mainAgent: { state: 'done' } })
  })

  // Also reached: Orca may handle the prompt's hook before the watch's next tick reads the line.
  it('retires the shell inside the notification turn when its prompt is handled first', async () => {
    const { server, cleared, replay } = await clearedWithShell()
    await replay([9])
    expect(row(server)).toMatchObject({ state: 'working', mainAgent: { state: 'working' } })
    appendFileSync(cleared, `${completed.lines[0]}\n`)
    await vi.waitFor(() => expect(storedTaskFact(server)).toBe(false), { timeout: 3_000 })
    expect(row(server)).toMatchObject({ state: 'working', mainAgent: { state: 'working' } })

    await replay([10])
    expect(row(server)).toMatchObject({ state: 'done', mainAgent: { state: 'done' } })
  })
})
