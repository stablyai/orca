// Claude kills every background agent on a single idle-prompt Ctrl+C and fires no hook. These
// stories replay hook payloads recorded from Claude Code 2.1.280 over a real PTY
// (src/shared/__fixtures__/claude-idle-ctrl-c-*-hooks.jsonl, sidecars beside them) through the
// server's own HTTP ingress, with each hook's `transcript_path` pointed at a temp file. The only
// trace of the kill is the id-less `system`/`agents_killed` line the CLI appended to its session
// transcript; the stories append that captured line where the keypress happened and let the
// listener's transcript watch find it on a real poll tick. The keypress itself decides nothing.
import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from './server'
import { buildBody, PANE, postHookEvent } from './server.test-fixtures'
import {
  cancelLabelled,
  hookAt,
  loadCapture,
  type CapturedRecord
} from './claude-cancel-capture.test-fixture'

const { getCohortAtEmitMock, trackMock } = vi.hoisted(() => ({
  getCohortAtEmitMock: vi.fn(),
  trackMock: vi.fn()
}))

vi.mock('../telemetry/client', () => ({
  track: trackMock
}))

vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: getCohortAtEmitMock
}))

const temporaryPaths: string[] = []
const running: AgentHookServer[] = []

beforeEach(() => {
  _internals.resetCachesForTests()
  trackMock.mockReset()
  getCohortAtEmitMock.mockReset()
  getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
  // Why: the roster stamps a child's start with Date.now(); the capture's own clock lines it up
  // with the CLI's `agents_killed` timestamp. Poll ticks stay on real timers.
  vi.useFakeTimers({ toFake: ['Date'] })
})

afterEach(() => {
  for (const server of running.splice(0)) {
    server.stop()
  }
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function transcriptFile(content = ''): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-agents-killed-'))
  temporaryPaths.push(dir)
  const path = join(dir, 'session.jsonl')
  writeFileSync(path, content)
  return path
}

async function startServer(): Promise<AgentHookServer> {
  const server = new AgentHookServer()
  running.push(server)
  await server.start({ env: 'production' })
  return server
}

function row(server: AgentHookServer) {
  const entry = server.getStatusSnapshotForPane(PANE)[0]
  if (!entry) {
    throw new Error('the pane has no row')
  }
  return entry
}

function watch(server: AgentHookServer) {
  return server._getStateForTests().claudeAgentsKilledCursorByPaneKey.get(PANE)
}

/** A capture replayed on its own clock, with every hook reporting `transcript` as its session file. */
function replayer(
  server: AgentHookServer,
  records: CapturedRecord[],
  transcript: string,
  t0: number
) {
  return async (indices: number[], payloadOverride: Record<string, unknown> = {}) => {
    for (const index of indices) {
      const hook = hookAt(records, index)
      vi.setSystemTime(t0 + hook.t * 1000)
      const payload = { ...hook.payload, transcript_path: transcript, ...payloadOverride }
      await expect(postHookEvent(server, buildBody(payload))).resolves.toMatchObject({
        status: 204
      })
    }
  }
}

/** The raw `agents_killed` line the CLI wrote for `cancelLabel`, and the capture's t=0 on the
 *  wall clock (the line is stamped within ~20 ms of the keypress). */
function capturedKill(records: CapturedRecord[], cancelLabel: string, scanLabel: string) {
  const cancel = cancelLabelled(records, cancelLabel)
  const scan = records.find((record) => record.kind === 'transcript' && record.label === scanLabel)
  if (scan?.kind !== 'transcript' || scan.agents_killed_records.length !== 1) {
    throw new Error(`Captured transcript scan ${scanLabel} has no single agents_killed line`)
  }
  const line = scan.agents_killed_records[0]
  // JSON.parse returns any; the subtype assertion is the shape proof.
  const parsed: Record<string, unknown> = JSON.parse(line)
  expect(parsed).toMatchObject({ type: 'system', subtype: 'agents_killed' })
  expect(parsed).not.toHaveProperty('agent_id')
  const killedAt = Date.parse(String(parsed.timestamp))
  return { cancel, line, killedAt, t0: killedAt - cancel.t * 1000 }
}

/** The renderer's part: capture the row as the baseline and, once the settle window passes with
 *  no hook, ask the server to infer from the Ctrl+C. */
function pressCtrlC(server: AgentHookServer): boolean {
  const baseline = row(server)
  return server.inferInterrupt({
    paneKey: PANE,
    baselineUpdatedAt: baseline.receivedAt,
    baselineStateStartedAt: baseline.stateStartedAt,
    baselinePrompt: baseline.prompt,
    baselineAgentType: 'claude',
    intent: 'ctrl-c'
  })
}

/** Waits for a poll tick to have read everything the transcript holds, or to have ended the watch. */
async function watchCaughtUp(server: AgentHookServer, transcript: string): Promise<void> {
  expect(watch(server)).toBeDefined()
  const size = statSync(transcript).size
  await vi.waitFor(() => expect(watch(server)?.offset ?? size).toBe(size), { timeout: 3_000 })
}

type CapturedBackgroundTask = { type: string }

function parseCapturedBackgroundTask(input: unknown): CapturedBackgroundTask | undefined {
  if (typeof input !== 'object' || input === null || !('type' in input)) {
    return undefined
  }
  return typeof input.type === 'string' ? { type: input.type } : undefined
}

describe('an idle-prompt Ctrl+C with a background shell and a background agent (captured)', () => {
  const records = loadCapture('claude-idle-ctrl-c-bg-agent-hooks')
  const kill = capturedKill(records, 'CTRL-C-idle-with-bg-shell-and-bg-agent', 'after-idle-ctrl-c')

  it('retires the agents the transcript says were killed, keeps the shell, and adds no verdict', async () => {
    const server = await startServer()
    const transcript = transcriptFile()
    const replay = replayer(server, records, transcript, kill.t0)
    await replay([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    // Both turns settled; the row is held open by the child work their Stops listed.
    expect(row(server)).toMatchObject({
      state: 'working',
      mainAgent: { state: 'done' },
      lastAssistantMessage: 'STARTED',
      toolName: 'Agent',
      subagents: [expect.objectContaining({ id: 'a2303994f3dfae83c', state: 'working' })]
    })
    expect(watch(server)).toMatchObject({ filePath: transcript })
    const settled = row(server)

    // The capture: the keypress painted "All background agents stopped", never "Interrupted",
    // and no hook followed it. The keypress on a settled main agent infers nothing.
    expect(kill.cancel).toMatchObject({
      all_bg_agents_stopped_painted: true,
      interrupted_painted: false,
      hooks_before_next_typed_prompt: []
    })
    vi.setSystemTime(kill.t0 + kill.cancel.t * 1000)
    expect(pressCtrlC(server)).toBe(false)
    expect(row(server)).toEqual(settled)

    vi.setSystemTime(kill.killedAt + 120)
    appendFileSync(transcript, `${kill.line}\n`)
    await vi.waitFor(() => expect(row(server).subagents).toBeUndefined(), { timeout: 3_000 })
    expect(row(server)).toMatchObject({
      state: 'working',
      workingMode: 'monitoring',
      mainAgent: { state: 'done' },
      lastAssistantMessage: 'STARTED',
      toolName: 'Agent',
      // Why: the drain repeats the Stop's turn stamp, so no second completion is announced.
      turnCompletedAt: settled.turnCompletedAt
    })
    expect(row(server).interrupted).toBeUndefined()
    expect(row(server).mainAgent).not.toHaveProperty('outcome')
    // Nothing is left to watch for.
    expect(watch(server)).toBeUndefined()

    // The next typed turn's Stop restates what the CLI now knows: the shell alone.
    await replay([11, 12])
    expect(hookAt(records, 12).payload.background_tasks).toEqual([
      expect.objectContaining({ type: 'shell', status: 'running' })
    ])
    expect(row(server)).toMatchObject({
      state: 'working',
      workingMode: 'monitoring',
      mainAgent: { state: 'done' }
    })
    expect(row(server).subagents).toBeUndefined()
  })

  it('settles the row to done when the killed agent was the only thing holding it open', async () => {
    // The rig always kept a shell alive, so this story removes the shell from the captured
    // inventory; the agent-only fold is what changes, not the payload shapes.
    const server = await startServer()
    const transcript = transcriptFile()
    const replay = replayer(server, records, transcript, kill.t0)
    await replay([0, 5, 6, 7, 8])
    const tasks = hookAt(records, 9).payload.background_tasks
    if (!Array.isArray(tasks)) {
      throw new Error('captured Stop lost its inventory')
    }
    await replay([9], {
      background_tasks: tasks.filter(
        (task) => parseCapturedBackgroundTask(task)?.type === 'subagent'
      )
    })
    await replay([10])
    expect(row(server)).toMatchObject({
      state: 'working',
      mainAgent: { state: 'done' },
      subagents: [expect.objectContaining({ state: 'working' })]
    })

    appendFileSync(transcript, `${kill.line}\n`)
    await vi.waitFor(() => expect(row(server).state).toBe('done'), { timeout: 3_000 })
    expect(row(server)).toMatchObject({
      mainAgent: { state: 'done' },
      lastAssistantMessage: 'STARTED'
    })
    expect(row(server).workingMode).toBeUndefined()
    expect(row(server).subagents).toBeUndefined()
    expect(row(server).interrupted).toBeUndefined()
  })

  it('keeps an inferred mid-turn cancel and still retires the agents a later kill ended', async () => {
    const server = await startServer()
    const transcript = transcriptFile()
    const replay = replayer(server, records, transcript, kill.t0)
    // Ctrl+C while the second turn runs: Claude cancels the turn (no hook) and keeps its agents.
    await replay([0, 1, 2, 3, 4, 5, 6, 7, 8])
    expect(row(server)).toMatchObject({ mainAgent: { state: 'working' } })
    expect(pressCtrlC(server)).toBe(true)
    expect(row(server)).toMatchObject({
      state: 'working',
      mainAgent: { state: 'done', outcome: 'cancellation' },
      subagents: [expect.objectContaining({ state: 'working' })]
    })

    // The idle Ctrl+C that follows kills them. The inferred cancel replaced the row without a
    // hook, and the watch follows the pane's current row, not the hook that armed it.
    appendFileSync(transcript, `${kill.line}\n`)
    await vi.waitFor(() => expect(row(server).subagents).toBeUndefined(), { timeout: 3_000 })
    expect(row(server)).toMatchObject({
      state: 'working',
      workingMode: 'monitoring',
      mainAgent: { state: 'done', outcome: 'cancellation' }
    })
  })

  it('ignores an agents_killed line already in the transcript when the watch arms', async () => {
    // `--resume` appends to the same file, so an earlier session's kill is still in it.
    const server = await startServer()
    const transcript = transcriptFile(`${kill.line}\n`)
    await replayer(server, records, transcript, kill.t0)([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    const held = row(server)
    appendFileSync(transcript, '{"type":"user"}\n')
    await watchCaughtUp(server, transcript)
    expect(row(server)).toEqual(held)
    expect(held.subagents).toEqual([expect.objectContaining({ state: 'working' })])
  })

  it('keeps a child that started after the kill the line records', async () => {
    const server = await startServer()
    const transcript = transcriptFile()
    await replayer(server, records, transcript, kill.t0)([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    const held = row(server)
    const startedAt = held.subagents?.[0]?.startedAt
    if (startedAt === undefined) {
      throw new Error('the captured child has no start')
    }
    const before = JSON.stringify({
      ...JSON.parse(kill.line),
      timestamp: new Date(startedAt - 1).toISOString()
    })
    appendFileSync(transcript, `${before}\n`)
    await watchCaughtUp(server, transcript)
    expect(row(server)).toEqual(held)
  })

  it('re-arms at the end of a forked transcript, which copies the old kill', async () => {
    // "Move to background and exit" forks the session into a NEW file that copies the old
    // `agents_killed` line (same uuid and timestamp).
    const server = await startServer()
    const replay = replayer(server, records, transcriptFile(), kill.t0)
    await replay([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    const forked = transcriptFile(`${kill.line}\n`)
    await replayer(server, records, forked, kill.t0)([10])
    expect(watch(server)).toMatchObject({ filePath: forked })
    const held = row(server)
    appendFileSync(forked, '{"type":"user"}\n')
    await watchCaughtUp(server, forked)
    expect(row(server)).toEqual(held)
  })

  it('drops the watch when the pane closes', async () => {
    const server = await startServer()
    const transcript = transcriptFile()
    await replayer(server, records, transcript, kill.t0)([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(watch(server)).toBeDefined()
    server.clearPaneState(PANE)
    expect(watch(server)).toBeUndefined()
  })
})

describe('an unsent draft before idle-prompt Ctrl+C (captured)', () => {
  const records = loadCapture('claude-idle-ctrl-c-draft-hooks')
  const kill = capturedKill(records, 'CTRL-C-draft-first', 'after-draft-ctrl-c')

  it('retires the agent the first keypress killed and leaves the shell alive', async () => {
    const server = await startServer()
    const transcript = transcriptFile()
    await replayer(server, records, transcript, kill.t0)([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(row(server)).toMatchObject({
      state: 'working',
      mainAgent: { state: 'done' },
      subagents: [expect.objectContaining({ state: 'working' })]
    })
    // The capture: the first keypress (clearing the draft) killed the agent's process and left
    // the shell; the second killed nothing. Only one line was written.
    expect(kill.cancel.draft_present).toBe(true)
    expect(kill.cancel.ps_after).toEqual([expect.stringContaining('sleep 600')])

    appendFileSync(transcript, `${kill.line}\n`)
    await vi.waitFor(() => expect(row(server).subagents).toBeUndefined(), { timeout: 3_000 })
    expect(row(server)).toMatchObject({
      state: 'working',
      workingMode: 'monitoring',
      mainAgent: { state: 'done' }
    })
    expect(row(server).interrupted).toBeUndefined()
  })
})

describe('an idle-prompt Ctrl+C with only a background shell (captured)', () => {
  const records = loadCapture('claude-idle-ctrl-c-shell-only-hooks')

  it('never watches, because no agent child is working', async () => {
    const server = await startServer()
    const transcript = transcriptFile()
    await replayer(server, records, transcript, Date.now())([0, 1, 2, 3, 4])
    expect(row(server)).toMatchObject({
      state: 'working',
      workingMode: 'monitoring',
      mainAgent: { state: 'done' }
    })
    expect(watch(server)).toBeUndefined()
    // The capture: no hook and no agents_killed line; the shell survived into the next Stop.
    const cancel = cancelLabelled(records, 'CTRL-C-idle-with-bg-shell-only')
    expect(cancel.hooks_before_next_typed_prompt).toEqual([])
    const before = row(server)
    expect(pressCtrlC(server)).toBe(false)
    expect(row(server)).toEqual(before)
  })
})

describe('an idle-prompt Ctrl+C after the background agent already finished (captured)', () => {
  const records = loadCapture('claude-idle-ctrl-c-finished-agent-hooks')

  it('disarms when the agent finishes, so a line written while unwatched never counts', async () => {
    const server = await startServer()
    const transcript = transcriptFile()
    const t0 = Date.now()
    const replay = replayer(server, records, transcript, t0)
    await replay([0, 1, 2, 3, 4, 5, 6, 7])
    expect(watch(server)).toBeDefined()
    // A NATURAL finish does announce itself: SubagentStop fires and the CLI injects a
    // task-notification turn whose Stop reports the drained inventory.
    expect(hookAt(records, 8).payload.hook_event_name).toBe('SubagentStop')
    await replay([8, 9, 10])
    expect(row(server)).toMatchObject({ state: 'done', mainAgent: { state: 'done' } })
    expect(watch(server)).toBeUndefined()

    const settled = row(server)
    expect(pressCtrlC(server)).toBe(false)
    appendFileSync(transcript, '{"type":"system","subtype":"agents_killed"}\n')
    expect(watch(server)).toBeUndefined()
    expect(row(server)).toEqual(settled)

    // A later background agent re-arms the watch at the transcript's end, past that line.
    vi.setSystemTime(t0 + 60_000)
    const start = { ...hookAt(records, 4).payload, transcript_path: transcript, agent_id: 'a01' }
    await expect(postHookEvent(server, buildBody(start))).resolves.toMatchObject({ status: 204 })
    expect(row(server).subagents).toEqual([
      expect.objectContaining({ id: 'a01', state: 'working' })
    ])
    appendFileSync(transcript, '{"type":"user"}\n')
    await watchCaughtUp(server, transcript)
    expect(row(server).subagents).toEqual([
      expect.objectContaining({ id: 'a01', state: 'working' })
    ])
  })
})
