/**
 * A command that runs inside a structured agent session is that session: the injected
 * `ORCA_AGENT_SESSION_ID` names the caller, and nothing resolves or guesses a terminal for it.
 *
 * One rule for every verb that names a caller: a caller flag may restate the session, but a flag
 * naming anyone else is refused before any request — never silently dropped, never allowed to win.
 * The #21097 accident was a chat that named a sibling's terminal and consumed that sibling's mail.
 *
 * The session env here is the hardest case, a chat in terminal view: it also carries its pane's
 * `ORCA_TERMINAL_HANDLE` and `ORCA_PANE_KEY`, and the implicit-terminal guess has a sibling to find.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.hoisted(() => vi.fn())
const getTerminalHandleMock = vi.hoisted(() => vi.fn())

vi.mock('./format', () => ({ printResult: vi.fn() }))
vi.mock('./selectors', () => ({ getTerminalHandle: getTerminalHandleMock }))

import { ORCHESTRATION_HANDLERS } from './handlers/orchestration'
import { createOrchestrationCompatibilityEnvelope } from './runtime/orchestration-compatibility-envelope'

const SESSION = 'f7a1c0de-1111-4222-8333-444455556666'
const IDENTITY_ENV = [
  'ORCA_AGENT_SESSION_ID',
  'ORCA_TERMINAL_HANDLE',
  'ORCA_PANE_KEY',
  'ORCA_STRUCTURED_SESSION'
] as const
const originalEnv = Object.fromEntries(IDENTITY_ENV.map((name) => [name, process.env[name]]))

/** Enough of every receipt shape that each handler finishes after its RPC. */
const RESULT = {
  result: {
    run: { id: 'run_1', objective: 'o', consumer_generation: 1 },
    runs: [],
    nextCursor: null,
    messages: [],
    count: 0,
    message: { id: 'msg_1' },
    lifecycle: { action: 'completed' },
    dispatch: { id: 'dispatch_1', task_id: 'task_1', status: 'dispatched' },
    gate: { id: 'gate_1', task_id: 'task_1', status: 'pending', resolution: 'r' },
    gates: [],
    task: { id: 'task_1', status: 'pending' },
    tasks: [],
    answer: 'yes',
    messageId: 'msg_1',
    threadId: 'thread_1',
    timedOut: false,
    state: 'ready',
    runId: 'run_1',
    taskId: 'task_1',
    dispatchId: 'dispatch_1',
    effects: [],
    residualResources: [],
    workers: [],
    counts: {}
  }
}

type Verb = {
  command: string
  flags: Record<string, string | true>
  /** The flag that names the caller, when the verb has one. */
  callerFlag?: 'from' | 'terminal'
  method: string
  callerParam: 'from' | 'terminal' | 'callerTerminalHandle'
}

/** Every verb whose request names its caller: the host's caller-param map, from the CLI side.
 *  `dispatch-show` is not one: its --from only fills preview text, so it is pinned on its own. */
const CALLER_VERBS: Verb[] = [
  {
    command: 'run-create',
    flags: { objective: 'o' },
    callerFlag: 'from',
    method: 'runCreate',
    callerParam: 'from'
  },
  {
    command: 'run-use',
    flags: { id: 'run_1' },
    callerFlag: 'from',
    method: 'runUse',
    callerParam: 'from'
  },
  {
    command: 'run-current',
    flags: {},
    callerFlag: 'from',
    method: 'runCurrent',
    callerParam: 'from'
  },
  { command: 'check', flags: {}, callerFlag: 'terminal', method: 'check', callerParam: 'terminal' },
  {
    command: 'send',
    flags: { to: 'term_worker', subject: 's', body: 'b' },
    callerFlag: 'from',
    method: 'send',
    callerParam: 'from'
  },
  {
    command: 'reply',
    flags: { id: 'msg_1', body: 'b' },
    callerFlag: 'from',
    method: 'reply',
    callerParam: 'from'
  },
  {
    command: 'ask',
    flags: { to: 'term_worker', question: 'q' },
    callerFlag: 'from',
    method: 'ask',
    callerParam: 'from'
  },
  {
    command: 'dispatch',
    flags: { task: 'task_1', to: 'term_worker' },
    callerFlag: 'from',
    method: 'dispatch',
    callerParam: 'from'
  },
  {
    command: 'gate-create',
    flags: { task: 'task_1', question: 'q' },
    callerFlag: 'from',
    method: 'gateCreate',
    callerParam: 'from'
  },
  {
    command: 'gate-resolve',
    flags: { id: 'gate_1', resolution: 'r' },
    callerFlag: 'from',
    method: 'gateResolve',
    callerParam: 'from'
  },
  { command: 'gate-list', flags: {}, callerFlag: 'from', method: 'gateList', callerParam: 'from' },
  {
    command: 'task-create',
    flags: { spec: 's' },
    callerFlag: 'from',
    method: 'taskCreate',
    callerParam: 'callerTerminalHandle'
  },
  {
    command: 'task-list',
    flags: {},
    callerFlag: 'from',
    method: 'taskList',
    callerParam: 'callerTerminalHandle'
  },
  {
    command: 'task-update',
    flags: { id: 'task_1', status: 'completed' },
    callerFlag: 'from',
    method: 'taskUpdate',
    callerParam: 'callerTerminalHandle'
  },
  {
    command: 'worker-start',
    flags: { spec: 's' },
    callerFlag: 'from',
    method: 'workerStart',
    callerParam: 'from'
  },
  // No caller flag: its spec takes none. It asks runCurrent for the caller's Run.
  { command: 'worker-list', flags: {}, method: 'runCurrent', callerParam: 'from' }
]

function flagMap(flags: Record<string, string | true>): Map<string, string | boolean> {
  return new Map(Object.entries(flags))
}

async function invoke(
  command: string,
  flags: Map<string, string | boolean>,
  json = true
): Promise<void> {
  const handler = ORCHESTRATION_HANDLERS[`orchestration ${command}`]
  if (!handler) {
    throw new Error(`no handler for ${command}`)
  }
  await handler({
    flags,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these handlers read only `call`; RuntimeClient is a class, so a structural double cannot satisfy it without the cast.
    client: { call: callMock } as never,
    cwd: '/tmp/repo',
    json
  })
}

function isParams(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function callsTo(method: string): Record<string, unknown>[] {
  return callMock.mock.calls
    .filter(([name]) => name === `orchestration.${method}`)
    .map(([, params]) => (isParams(params) ? params : {}))
}

function setEnv(env: Partial<Record<(typeof IDENTITY_ENV)[number], string>>): void {
  for (const name of IDENTITY_ENV) {
    const value = env[name]
    if (value === undefined) {
      delete process.env[name]
    } else {
      process.env[name] = value
    }
  }
}

/** A chat in terminal view: its id, plus the pane identity that view inherits. */
function asSessionInTerminalView(): void {
  setEnv({
    ORCA_AGENT_SESSION_ID: SESSION,
    ORCA_TERMINAL_HANDLE: 'term_view_pane',
    ORCA_PANE_KEY: 'tab_view:11111111-1111-4111-8111-111111111111'
  })
}

beforeEach(() => {
  callMock.mockReset().mockResolvedValue(RESULT)
  getTerminalHandleMock.mockReset().mockResolvedValue('term_sibling')
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  setEnv(originalEnv)
  process.exitCode = undefined
})

describe.each(CALLER_VERBS)('orchestration $command run as an agent session', (verb) => {
  beforeEach(asSessionInTerminalView)

  it('acts as the session: no terminal is resolved, guessed or sent', async () => {
    await invoke(verb.command, flagMap(verb.flags))

    const [params] = callsTo(verb.method)
    expect(params, 'the verb reached its method').toBeDefined()
    expect(params?.[verb.callerParam]).toBeUndefined()
    // A terminal view's pane is not the session's identity.
    expect(params?.terminalPaneKey).toBeUndefined()
    expect(params?.senderPaneKey).toBeUndefined()
    expect(getTerminalHandleMock).not.toHaveBeenCalled()
    expect(callMock.mock.calls.map(([name]) => name)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^terminal\./)])
    )
  })

  it.runIf(verb.callerFlag !== undefined)(
    'refuses a caller flag naming another actor, before any request',
    async () => {
      const flags = flagMap({ ...verb.flags, [verb.callerFlag ?? 'from']: 'term_sibling' })

      await expect(invoke(verb.command, flags)).rejects.toMatchObject({
        code: 'consumer_fenced',
        message: expect.stringContaining(`agent session ${SESSION}`)
      })
      expect(callMock).not.toHaveBeenCalled()
      expect(getTerminalHandleMock).not.toHaveBeenCalled()
    }
  )

  it.runIf(verb.callerFlag !== undefined)(
    "refuses its own terminal view's pane handle too: the session, not the pane, is the caller",
    async () => {
      const flags = flagMap({ ...verb.flags, [verb.callerFlag ?? 'from']: 'term_view_pane' })

      await expect(invoke(verb.command, flags)).rejects.toMatchObject({ code: 'consumer_fenced' })
      expect(callMock).not.toHaveBeenCalled()
    }
  )

  it.runIf(verb.callerFlag !== undefined).each([`session:${SESSION}`, SESSION])(
    'accepts a caller flag that restates the session (%s)',
    async (restated) => {
      await invoke(verb.command, flagMap({ ...verb.flags, [verb.callerFlag ?? 'from']: restated }))

      const [params] = callsTo(verb.method)
      expect(params, 'the verb reached its method').toBeDefined()
      expect(params?.[verb.callerParam]).toBeUndefined()
    }
  )
})

describe('the identity a session presents', () => {
  it("lets a structured worker restate its own minted handle, and nobody else's", async () => {
    setEnv({ ORCA_AGENT_SESSION_ID: SESSION, ORCA_TERMINAL_HANDLE: 'structworker_self' })

    await invoke('send', flagMap({ from: 'structworker_self', to: 'run:run_1', subject: 's' }))
    expect(callsTo('send')[0]?.from).toBeUndefined()

    callMock.mockClear()
    await expect(
      invoke('send', flagMap({ from: 'structworker_other', to: 'run:run_1', subject: 's' }))
    ).rejects.toMatchObject({ code: 'consumer_fenced' })
    expect(callMock).not.toHaveBeenCalled()
  })

  it("sends a structured worker's lifecycle report as the session, not refused as identity-less", async () => {
    setEnv({ ORCA_AGENT_SESSION_ID: SESSION })

    await invoke(
      'send',
      flagMap({ to: 'run:run_1', subject: 'done', type: 'worker_done', outcome: 'succeeded' })
    )

    expect(callsTo('send')[0]).toMatchObject({ type: 'worker_done' })
    expect(callsTo('send')[0]?.from).toBeUndefined()
  })

  it('never treats a session that has an id as identity-less, even beside the old marker', async () => {
    setEnv({ ORCA_AGENT_SESSION_ID: SESSION, ORCA_STRUCTURED_SESSION: '1' })

    await invoke('check', flagMap({}))

    expect(callsTo('check')).toHaveLength(1)
    expect(getTerminalHandleMock).not.toHaveBeenCalled()
  })

  it('keeps the identity-less refusal, without --from advice, for a child that has no id', async () => {
    setEnv({ ORCA_STRUCTURED_SESSION: '1' })

    await expect(invoke('reply', flagMap({ id: 'msg_1', body: 'b' }))).rejects.toMatchObject({
      code: 'no_active_sender_terminal',
      message: expect.not.stringContaining('Pass --from')
    })
    expect(getTerminalHandleMock).not.toHaveBeenCalled()
    expect(callMock).not.toHaveBeenCalled()
  })

  it('leaves a terminal agent exactly as it was: its own handle is the caller', async () => {
    setEnv({ ORCA_TERMINAL_HANDLE: 'term_pty', ORCA_PANE_KEY: 'tab_pty:1:2' })
    callMock.mockImplementation(async (name: string) =>
      name === 'terminal.resolveIdentity' ? { result: { identity: { live: true } } } : RESULT
    )

    await invoke('run-create', flagMap({ objective: 'o' }))
    await invoke('check', flagMap({}))

    expect(callsTo('runCreate')[0]?.from).toBe('term_pty')
    expect(callsTo('check')[0]).toMatchObject({
      terminal: 'term_pty',
      terminalPaneKey: 'tab_pty:1:2'
    })
  })

  it('previews a dispatch with the coordinator address the real dispatch would write', async () => {
    const preview = async (flags: Record<string, string | true>) => {
      callMock.mockClear()
      await invoke('dispatch-show', flagMap({ task: 'task_1', preamble: true, ...flags }))
      return callsTo('dispatchShow')[0]?.from
    }
    asSessionInTerminalView()
    expect(await preview({})).toBe(`session:${SESSION}`)
    // Not a caller flag: it names the text to preview, so it is never fenced.
    expect(await preview({ from: 'term_sibling' })).toBe('term_sibling')
    setEnv({ ORCA_AGENT_SESSION_ID: SESSION, ORCA_TERMINAL_HANDLE: 'structworker_self' })
    expect(await preview({})).toBe('structworker_self')
    expect(getTerminalHandleMock).not.toHaveBeenCalled()
  })

  it('resumes a timed-out ask as the session, without naming a terminal', async () => {
    asSessionInTerminalView()
    callMock.mockResolvedValue({ result: { ...RESULT.result, answer: null, timedOut: true } })
    const errors = vi.mocked(console.error)

    await invoke('ask', flagMap({ to: 'term_worker', question: 'q' }), false)

    const advice = errors.mock.calls.map(([line]) => String(line)).join('\n')
    expect(advice).toContain('--resume msg_1')
    expect(advice).not.toContain('--from')
  })
})

describe('the orchestration envelope', () => {
  it('carries the injected id beside whatever terminal evidence the process also has', () => {
    const envelope = createOrchestrationCompatibilityEnvelope({
      ORCA_AGENT_SESSION_ID: ` ${SESSION} `,
      ORCA_TERMINAL_HANDLE: 'term_view_pane'
    })

    expect(envelope.orchestrationCompatibilityEvidence).toEqual({
      terminalHandle: 'term_view_pane',
      agentSessionId: SESSION
    })
  })

  it('claims no session without an injected id', () => {
    expect(
      createOrchestrationCompatibilityEnvelope({ ORCA_AGENT_SESSION_ID: '  ' })
        .orchestrationCompatibilityEvidence
    ).toBeUndefined()
  })

  it('keeps a WSL stamp beside the id, so the host can refuse the cross-host claim', () => {
    const envelope = createOrchestrationCompatibilityEnvelope({
      ORCA_AGENT_SESSION_ID: SESSION,
      ORCA_ORCHESTRATION_COMPATIBILITY_HOST_KIND: 'wsl',
      ORCA_ORCHESTRATION_COMPATIBILITY_HOST_ID: 'local',
      ORCA_ORCHESTRATION_COMPATIBILITY_HOST_INCARNATION: 'Ubuntu'
    })

    expect(envelope.orchestrationCompatibilityEvidence).toEqual({
      agentSessionId: SESSION,
      host: { kind: 'wsl', hostId: 'local', distro: 'Ubuntu' }
    })
  })
})

describe('every orchestration verb, enumerated', () => {
  /** Enough flags for any verb to get past its own validation to identity resolution. */
  const EVERY_REQUIRED_FLAG = {
    objective: 'o',
    id: 'id_1',
    task: 'task_1',
    spec: 's',
    question: 'q',
    resolution: 'r',
    subject: 's',
    body: 'b',
    to: 'term_worker',
    status: 'completed',
    preamble: true,
    request: 'req_1'
  } as const

  /** Runs every verb once; returns the ones that guessed an implicit terminal. */
  async function verbsThatGuess(): Promise<string[]> {
    const guessed: string[] = []
    for (const command of Object.keys(ORCHESTRATION_HANDLERS)) {
      const verb = command.replace('orchestration ', '')
      getTerminalHandleMock.mockClear()
      callMock.mockClear()
      await invoke(verb, flagMap(EVERY_REQUIRED_FLAG)).catch(() => undefined)
      if (getTerminalHandleMock.mock.calls.length > 0) {
        guessed.push(verb)
      }
    }
    return guessed.sort()
  }

  it('guesses a terminal for no verb when the session id is present', async () => {
    // Positive control first: with no identity at all the same harness sees the guess, so an empty
    // result below is about the id, not a harness that cannot observe a guess.
    setEnv({})
    const population = await verbsThatGuess()
    expect(population).toEqual([
      'ask',
      'check',
      'dispatch',
      'dispatch-show',
      'gate-create',
      'gate-list',
      'gate-resolve',
      'reply',
      'run-create',
      'run-current',
      'run-use',
      'send',
      'task-create',
      'task-list',
      'task-update',
      'worker-list',
      'worker-start'
    ])

    asSessionInTerminalView()
    expect(await verbsThatGuess()).toEqual([])
  })
})
