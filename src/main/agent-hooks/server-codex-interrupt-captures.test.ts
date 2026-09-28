// Codex reports its own cancel. These stories replay hook payloads recorded from real Codex TUIs
// over a PTY with Orca's Interrupt hook registered (src/shared/__fixtures__/codex-interrupt-hooks.jsonl,
// sidecar beside it) through the server's own HTTP ingress. The capture established that Interrupt
// fires on every real cancel (Ctrl+C, Esc, the shared-server chooser's "Cancel task" and "Exit", a
// cancelled approval prompt) and only for the main agent; that no main-agent hook follows it; that
// a running subagent survives and later fires its own SubagentStop; and that a key which cancels
// nothing (a draft-clearing Ctrl+C, a popup-closing Esc, "Run in background") fires no Interrupt.
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from './server'
import { buildBody, PANE, postHookEvent } from './server.test-fixtures'

const { getCohortAtEmitMock, trackMock } = vi.hoisted(() => ({
  getCohortAtEmitMock: vi.fn(),
  trackMock: vi.fn()
}))

vi.mock('../telemetry/client', () => ({ track: trackMock }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: getCohortAtEmitMock }))

type CapturedHook = {
  kind: 'hook'
  run: string
  t: number
  index: number
  payload: Record<string, unknown>
}
type CapturedKey = { kind: 'key'; run: string; t: number; key: string; label: string }
type CapturedRecord =
  | CapturedHook
  | CapturedKey
  | { kind: 'prompt'; run: string; t: number; text: string }
  | { kind: 'screen'; run: string; t: number; label: string; chooser: boolean }

const CAPTURE: CapturedRecord[] = readFileSync(
  join(__dirname, '..', '..', 'shared', '__fixtures__', 'codex-interrupt-hooks.jsonl'),
  'utf8'
)
  .trim()
  .split('\n')
  .map((line) => {
    // JSON.parse returns any; the kind check below is what proves the record shape.
    const parsed: CapturedRecord = JSON.parse(line)
    if (!['hook', 'key', 'prompt', 'screen'].includes(parsed.kind)) {
      throw new Error(`Unknown capture record: ${line}`)
    }
    return parsed
  })

function hooksOf(run: string): CapturedHook[] {
  return CAPTURE.filter(
    (record): record is CapturedHook => record.kind === 'hook' && record.run === run
  )
}

function keyLabelled(run: string, label: string): CapturedKey {
  const key = CAPTURE.find(
    (record) => record.kind === 'key' && record.run === run && record.label === label
  )
  if (key?.kind !== 'key') {
    throw new Error(`Captured key ${label} not found in ${run}`)
  }
  return key
}

const eventOf = (hook: CapturedHook): unknown => hook.payload.hook_event_name
const turnOf = (hook: CapturedHook): unknown => hook.payload.turn_id
const isMainAgent = (hook: CapturedHook): boolean => hook.payload.agent_id === undefined

beforeEach(() => {
  _internals.resetCachesForTests()
  trackMock.mockReset()
  getCohortAtEmitMock.mockReset()
  getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Codex cancels replayed from the Interrupt capture', () => {
  let server: AgentHookServer

  beforeEach(async () => {
    server = new AgentHookServer()
    await server.start({ env: 'production' })
  })

  afterEach(() => {
    server.stop()
  })

  function row() {
    const entry = server.getStatusSnapshot()[0]
    if (!entry) {
      throw new Error('the pane has no row')
    }
    return entry
  }

  async function post(hook: CapturedHook): Promise<void> {
    await expect(
      postHookEvent(server, buildBody(hook.payload), '/hook/codex')
    ).resolves.toMatchObject({ status: 204 })
  }

  /** What the renderer would have asked for if it still read the key as a cancel. */
  function pressKey(intent: 'ctrl-c' | 'plain-escape'): boolean {
    const baseline = row()
    return server.inferInterrupt({
      paneKey: PANE,
      baselineUpdatedAt: baseline.receivedAt,
      baselineStateStartedAt: baseline.stateStartedAt,
      baselinePrompt: baseline.prompt,
      baselineAgentType: 'codex',
      intent
    })
  }

  it.each([
    ['run-a-0.156.1', 'S1#1 ctrl-c mid-turn busy subagent'],
    ['run-b-0.156.1', 'S1#2 ctrl-c mid-turn busy subagent'],
    ['run-c-0.156.1', 'S1#3 ctrl-c mid-turn busy subagent'],
    ['run-d-0.156.1', 'S2 esc mid-turn busy subagent'],
    ['run-s1-0.157.0', 'S1 ctrl-c mid-turn busy subagent -> Enter on Cancel task'],
    ['run-esc-0.157.0', 'S2 esc mid-turn busy subagent'],
    ['run-exit-0.157.0', 'D4 Enter on Exit']
  ])(
    '%s (%s): the main agent reads cancelled at once, the subagent holds the row until its SubagentStop',
    async (run, label) => {
      const hooks = hooksOf(run)
      const key = keyLabelled(run, label)
      const interruptAt = hooks.findIndex((hook) => hook.t > key.t && eventOf(hook) === 'Interrupt')
      const interrupt = hooks[interruptAt]!
      const subagentStopAt = hooks.findIndex(
        (hook, index) => index > interruptAt && eventOf(hook) === 'SubagentStop'
      )
      // The capture itself: Interrupt is the main agent's, and no main hook restates its turn.
      expect(isMainAgent(interrupt)).toBe(true)
      expect(subagentStopAt).toBeGreaterThan(interruptAt)
      expect(
        hooks
          .slice(interruptAt + 1)
          .some((hook) => isMainAgent(hook) && turnOf(hook) === turnOf(interrupt))
      ).toBe(false)

      for (const hook of hooks.slice(0, interruptAt)) {
        await post(hook)
      }
      expect(row()).toMatchObject({
        state: 'working',
        mainAgent: { state: 'working' },
        subagents: [expect.objectContaining({ state: 'working' })]
      })
      // Whatever the renderer makes of the key, the server never reads a Codex key as a cancel.
      expect(pressKey(key.key === 'esc' ? 'plain-escape' : 'ctrl-c')).toBe(false)

      await post(interrupt)
      const cancelled = row().mainAgent
      expect(row()).toMatchObject({
        state: 'working',
        mainAgent: { state: 'done', outcome: 'cancellation' },
        subagents: [expect.objectContaining({ state: 'working' })]
      })
      expect(row().interrupted).toBeUndefined()

      for (const hook of hooks.slice(interruptAt + 1, subagentStopAt)) {
        await post(hook)
        expect(row()).toMatchObject({ state: 'working', mainAgent: cancelled })
      }
      await post(hooks[subagentStopAt]!)
      expect(row()).toMatchObject({ state: 'done', interrupted: true, mainAgent: cancelled })
      expect(row().subagents).toBeUndefined()

      // The next turn is Codex working again, and a turn that completes is not a cancel.
      const nextStopAt = hooks.findIndex(
        (hook, index) =>
          index > subagentStopAt && (eventOf(hook) === 'Stop' || eventOf(hook) === 'Interrupt')
      )
      if (nextStopAt === -1 || eventOf(hooks[nextStopAt]!) !== 'Stop') {
        return
      }
      for (const hook of hooks.slice(subagentStopAt + 1, nextStopAt)) {
        await post(hook)
        expect(row().mainAgent).toMatchObject({ state: 'working' })
      }
      await post(hooks[nextStopAt]!)
      expect(row()).toMatchObject({ state: 'done', mainAgent: { state: 'done' } })
      expect(row().interrupted).toBeUndefined()
      expect(row().mainAgent?.outcome).toBeUndefined()
    }
  )

  it.each([
    ['run-c-0.156.1', 'S7 ctrl-c mid-turn no subagent'],
    ['run-d-0.156.1', 'S3 real ctrl-c'],
    ['run-d-0.156.1', 'S10 ctrl-c opens chooser'],
    ['run-d-0.156.1', 'S6d ctrl-c #2'],
    ['run-d-0.157.0', 'S3 real ctrl-c -> Enter on Cancel task'],
    ['run-s9-0.156.1', 'S9 ctrl-c on approval prompt']
  ])('%s (%s): with nothing left running the row settles cancelled', async (run, label) => {
    const hooks = hooksOf(run)
    const key = keyLabelled(run, label)
    const interruptAt = hooks.findIndex((hook) => hook.t > key.t && eventOf(hook) === 'Interrupt')
    for (const hook of hooks.slice(0, interruptAt)) {
      await post(hook)
    }
    expect(row().state).toBe(run === 'run-s9-0.156.1' ? 'waiting' : 'working')

    await post(hooks[interruptAt]!)
    expect(row()).toMatchObject({
      state: 'done',
      interrupted: true,
      mainAgent: { state: 'done', outcome: 'cancellation' }
    })

    const next = hooks[interruptAt + 1]
    if (next) {
      // The next prompt is another turn id, so the cancel does not hold it.
      expect(eventOf(next)).toBe('UserPromptSubmit')
      expect(turnOf(next)).not.toBe(turnOf(hooks[interruptAt]!))
      await post(next)
      expect(row()).toMatchObject({ state: 'working', mainAgent: { state: 'working' } })
    }
  })

  it.each([
    ['run-d-0.156.1', 'S3 ctrl-c clears composer', 'ctrl-c'],
    ['run-d-0.156.1', 'S4 esc closes popup', 'plain-escape'],
    ['run-d-0.157.0', 'S3 ctrl-c clears composer', 'ctrl-c'],
    ['run-d-0.157.0', 'S4 esc closes popup', 'plain-escape'],
    ['run-d-0.157.0', 'S10 esc dismisses chooser', 'plain-escape'],
    ['run-d3bg-0.157.0', 'D4 Enter on Exit', 'ctrl-c']
  ] as const)(
    '%s (%s): a key that cancels nothing leaves the turn working',
    async (run, label, intent) => {
      const hooks = hooksOf(run)
      const key = keyLabelled(run, label)
      const before = hooks.filter((hook) => hook.t < key.t)
      const turn = turnOf(before.findLast(isMainAgent)!)
      const nextMainAt = hooks.findIndex((hook) => hook.t > key.t && isMainAgent(hook))
      const nextMain = hooks[nextMainAt]!
      // The capture itself: the turn goes on, with no Interrupt in between.
      expect(turnOf(nextMain)).toBe(turn)
      expect(eventOf(nextMain)).not.toBe('Interrupt')

      for (const hook of before) {
        await post(hook)
      }
      expect(row()).toMatchObject({ state: 'working', mainAgent: { state: 'working' } })
      expect(pressKey(intent)).toBe(false)
      expect(row()).toMatchObject({ state: 'working', mainAgent: { state: 'working' } })

      for (const hook of hooks.slice(before.length, nextMainAt + 1)) {
        await post(hook)
      }
      expect(row()).toMatchObject({ state: 'working', mainAgent: { state: 'working' } })
      const stopAt = hooks.findIndex(
        (hook, index) =>
          index > nextMainAt &&
          isMainAgent(hook) &&
          turnOf(hook) === turn &&
          eventOf(hook) === 'Stop'
      )
      if (stopAt === -1) {
        return
      }
      for (const hook of hooks.slice(nextMainAt + 1, stopAt + 1)) {
        await post(hook)
      }
      expect(row().mainAgent).toMatchObject({ state: 'done' })
      expect(row().mainAgent?.outcome).toBeUndefined()
    }
  )
})

describe("a subagent outlives the main agent's turn", () => {
  let server: AgentHookServer

  beforeEach(async () => {
    server = new AgentHookServer()
    await server.start({ env: 'production' })
  })

  afterEach(() => {
    server.stop()
  })

  const row = () => server.getStatusSnapshot()[0]!
  async function post(payload: Record<string, unknown>): Promise<void> {
    await expect(postHookEvent(server, buildBody(payload), '/hook/codex')).resolves.toMatchObject({
      status: 204
    })
  }

  // In this capture the main agent's turn ends while its subagent is still working.
  it('run-d3bg-0.157.0 (Run in background): the turn reads working with its prompt, and its Stop leaves the running subagent holding the row', async () => {
    const hooks = hooksOf('run-d3bg-0.157.0')
    const stopAt = hooks.findIndex((hook) => isMainAgent(hook) && eventOf(hook) === 'Stop')
    const subagentStopAt = hooks.findIndex((hook) => eventOf(hook) === 'SubagentStop')
    // The capture itself: the main agent's turn ends while its subagent is still working.
    expect(stopAt).toBeGreaterThan(0)
    expect(subagentStopAt).toBeGreaterThan(stopAt)
    expect(hooks.slice(stopAt + 1, subagentStopAt).every((hook) => !isMainAgent(hook))).toBe(true)

    for (const hook of hooks.slice(0, stopAt)) {
      await post(hook.payload)
    }
    const prompt = row().prompt
    expect(prompt.length).toBeGreaterThan(0)
    expect(row()).toMatchObject({ state: 'working', mainAgent: { state: 'working' } })

    await post(hooks[stopAt]!.payload)
    expect(row()).toMatchObject({
      state: 'working',
      prompt,
      mainAgent: { state: 'done' },
      subagents: [expect.objectContaining({ state: 'working' })]
    })
    for (const hook of hooks.slice(stopAt + 1, subagentStopAt)) {
      await post(hook.payload)
      expect(row()).toMatchObject({ state: 'working', mainAgent: { state: 'done' } })
    }
    await post(hooks[subagentStopAt]!.payload)
    expect(row()).toMatchObject({ state: 'done', prompt, mainAgent: { state: 'done' } })
    expect(row().subagents).toBeUndefined()
    expect(row().interrupted).toBeUndefined()
  })

  // Measured live on 0.157.1: a new prompt while a cancel's subagent still ran, whose turn ended
  // with Stop about a minute before the subagent's SubagentStop. The follow-up turn is built from
  // the run's own main-agent hook shape, under a turn id the capture does not use.
  it("run-esc-0.157.0: a new turn that ends while the cancelled turn's subagent still runs leaves it holding the row", async () => {
    const hooks = hooksOf('run-esc-0.157.0')
    const interruptAt = hooks.findIndex((hook) => eventOf(hook) === 'Interrupt')
    const subagentStopAt = hooks.findIndex((hook) => eventOf(hook) === 'SubagentStop')
    const { turn_id: _cancelledTurn, ...mainHook } = hooks[interruptAt]!.payload
    for (const hook of hooks.slice(0, interruptAt + 1)) {
      await post(hook.payload)
    }

    await post({
      ...mainHook,
      hook_event_name: 'UserPromptSubmit',
      turn_id: 'next-turn',
      prompt: 'next'
    })
    expect(row()).toMatchObject({
      state: 'working',
      prompt: 'next',
      mainAgent: { state: 'working' }
    })
    await post({ ...mainHook, hook_event_name: 'Stop', turn_id: 'next-turn' })
    expect(row()).toMatchObject({
      state: 'working',
      mainAgent: { state: 'done' },
      subagents: [expect.objectContaining({ state: 'working' })]
    })
    expect(row().mainAgent?.outcome).toBeUndefined()

    for (const hook of hooks.slice(interruptAt + 1, subagentStopAt)) {
      await post(hook.payload)
      expect(row()).toMatchObject({ state: 'working', mainAgent: { state: 'done' } })
    }
    await post(hooks[subagentStopAt]!.payload)
    // The latest turn completed, so the settled row carries no cancel.
    expect(row()).toMatchObject({ state: 'done', mainAgent: { state: 'done' } })
    expect(row().interrupted).toBeUndefined()
  })
})

describe('a lost Codex Interrupt, settled from the turn_aborted Codex writes after it', () => {
  // Captured in run-d-0.157.0: Codex killed the Esc cancel's Interrupt hook at its 3s cap, so it
  // never arrived; Codex still wrote `turn_aborted` for the turn to its rollout once the hook ended.
  const RUN = 'run-d-0.157.0'
  const dirs: string[] = []
  let server: AgentHookServer

  beforeEach(async () => {
    server = new AgentHookServer()
    await server.start({ env: 'production' })
  })

  afterEach(() => {
    server.stop()
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true })
    }
    dirs.length = 0
  })

  // Shaped as Codex writes it: `turn_aborted` carries its `TurnAbortReason`.
  function rolloutLine(type: string, turnId: unknown): string {
    const payload =
      type === 'turn_aborted'
        ? { type, turn_id: turnId, reason: 'interrupted' }
        : { type, turn_id: turnId }
    return `${JSON.stringify({ type: 'event_msg', payload })}\n`
  }

  /** The run's hooks up to its lost cancel, with the parent rollout moved to a writable file. */
  function setUp(): {
    rollout: string
    turn: unknown
    before: CapturedHook[]
    after: CapturedHook[]
    post: (hook: CapturedHook) => Promise<void>
  } {
    const dir = mkdtempSync(join(tmpdir(), 'codex-lost-interrupt-'))
    dirs.push(dir)
    const rollout = join(dir, 'rollout-parent.jsonl')
    const hooks = hooksOf(RUN)
    const esc = keyLabelled(RUN, 'S2 esc mid-turn busy subagent')
    const before = hooks.filter((hook) => hook.t < esc.t)
    const main = before.findLast(isMainAgent)!
    const parentPath = main.payload.transcript_path
    writeFileSync(rollout, rolloutLine('task_started', turnOf(main)))
    return {
      rollout,
      turn: turnOf(main),
      before,
      after: hooks.filter((hook) => hook.t > esc.t),
      post: async (hook) => {
        const payload =
          hook.payload.transcript_path === parentPath
            ? { ...hook.payload, transcript_path: rollout }
            : hook.payload
        await expect(
          postHookEvent(server, buildBody(payload), '/hook/codex')
        ).resolves.toMatchObject({ status: 204 })
      }
    }
  }

  it('reads the cancel from turn_aborted within one rollout read, with no further hook', async () => {
    const { rollout, turn, before, after, post } = setUp()
    // The capture itself: nothing restates or ends the main agent's turn after the Esc.
    expect(
      after.some(
        (hook) => isMainAgent(hook) && turnOf(hook) === turn && eventOf(hook) !== 'UserPromptSubmit'
      )
    ).toBe(false)
    for (const hook of before) {
      await post(hook)
    }
    expect(server.getStatusSnapshot()[0]).toMatchObject({
      state: 'working',
      mainAgent: { state: 'working' }
    })

    appendFileSync(rollout, rolloutLine('turn_aborted', turn))
    await vi.waitFor(
      () => {
        expect(server.getStatusSnapshot()[0]).toMatchObject({
          state: 'working',
          mainAgent: { state: 'done', outcome: 'cancellation' },
          subagents: [expect.objectContaining({ state: 'working' })]
        })
      },
      { timeout: 3_000, interval: 50 }
    )
  })

  it('reads it on the very next subagent hook, and settles on the SubagentStop', async () => {
    const { rollout, turn, before, after, post } = setUp()
    for (const hook of before) {
      await post(hook)
    }
    appendFileSync(rollout, rolloutLine('turn_aborted', turn))
    const subagentStopAt = after.findIndex((hook) => eventOf(hook) === 'SubagentStop')
    await post(after[0]!)
    expect(isMainAgent(after[0]!)).toBe(false)
    expect(server.getStatusSnapshot()[0]).toMatchObject({
      state: 'working',
      mainAgent: { state: 'done', outcome: 'cancellation' }
    })
    for (const hook of after.slice(1, subagentStopAt + 1)) {
      await post(hook)
    }
    expect(server.getStatusSnapshot()[0]).toMatchObject({
      state: 'done',
      interrupted: true,
      mainAgent: { state: 'done', outcome: 'cancellation' }
    })
  })

  it('reads a completed turn from task_complete when its Stop is lost', async () => {
    const { rollout, turn, before, post } = setUp()
    for (const hook of before) {
      await post(hook)
    }
    appendFileSync(rollout, rolloutLine('task_complete', turn))
    await vi.waitFor(
      () => {
        expect(server.getStatusSnapshot()[0]?.mainAgent).toMatchObject({ state: 'done' })
      },
      { timeout: 3_000, interval: 50 }
    )
    expect(server.getStatusSnapshot()[0]?.mainAgent?.outcome).toBeUndefined()
  })

  it("ignores another turn's end in the rollout", async () => {
    const { rollout, before, post } = setUp()
    for (const hook of before) {
      await post(hook)
    }
    appendFileSync(rollout, rolloutLine('turn_aborted', 'an-earlier-turn'))
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    expect(server.getStatusSnapshot()[0]?.mainAgent).toMatchObject({ state: 'working' })
  })
})
