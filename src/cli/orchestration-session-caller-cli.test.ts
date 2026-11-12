// Inherited pane identity and an available sibling must never override the injected session caller.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.hoisted(() => vi.fn())
const getTerminalHandleMock = vi.hoisted(() => vi.fn())

vi.mock('./command-result-output', () => ({ printResult: vi.fn() }))
vi.mock('./selectors', () => ({ getTerminalHandle: getTerminalHandleMock }))

import { ORCHESTRATION_HANDLERS } from './handlers/orchestration'
import { findCommandSpec } from './args'
import { COMMAND_SPECS } from './specs'
import { refuseConflictingSessionCallerFlags } from './session-caller-flags'
import { createOrchestrationCompatibilityEnvelope } from './runtime/orchestration-compatibility-envelope'

import { formatCliError } from './cli-error'
import { RuntimeRpcFailureError } from './runtime/types'

const SESSION = 'f7a1c0de-1111-4222-8333-444455556666'
const IDENTITY_ENV = [
  'ORCA_AGENT_SESSION_ID',
  'ORCA_TERMINAL_HANDLE',
  'ORCA_PANE_KEY',
  'ORCA_STRUCTURED_SESSION'
] as const
const originalEnv = Object.fromEntries(IDENTITY_ENV.map((name) => [name, process.env[name]]))

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
  callerFlag?: 'from' | 'terminal'
  method: string
  callerParam: 'from' | 'terminal' | 'callerTerminalHandle'
}

/** dispatch-show is excluded: its --from fills preview text rather than naming the caller. */
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
  { command: 'worker-list', flags: {}, method: 'runCurrent', callerParam: 'from' }
]

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
  refuseConflictingSessionCallerFlags(
    findCommandSpec(COMMAND_SPECS, ['orchestration', command]),
    flags
  )
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

function asSessionWithInheritedPane(): void {
  setEnv({
    ORCA_AGENT_SESSION_ID: SESSION,
    ORCA_TERMINAL_HANDLE: 'term_inherited_pane',
    ORCA_PANE_KEY: 'tab_inherited:11111111-1111-4111-8111-111111111111'
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
  beforeEach(asSessionWithInheritedPane)

  it.runIf(verb.callerFlag !== undefined)(
    'refuses a caller flag naming another caller, before any request',
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
    'refuses an inherited pane handle too: the session, not the pane, is the caller',
    async () => {
      const flags = flagMap({ ...verb.flags, [verb.callerFlag ?? 'from']: 'term_inherited_pane' })

      await expect(invoke(verb.command, flags)).rejects.toMatchObject({ code: 'consumer_fenced' })
      expect(callMock).not.toHaveBeenCalled()
    }
  )
})

describe.each([
  { command: 'gate-list', method: 'gateList', callerParam: 'from' },
  { command: 'task-list', method: 'taskList', callerParam: 'callerTerminalHandle' }
])('orchestration $command --run run as an agent session', ({ command, method, callerParam }) => {
  beforeEach(asSessionWithInheritedPane)

  it('needs no caller, but refuses a --from naming another caller, before any request', async () => {
    await invoke(command, flagMap({ run: 'run_1' }))
    expect(callsTo(method)[0]).toMatchObject({ run: 'run_1' })
    expect(callsTo(method)[0]?.[callerParam]).toBeUndefined()

    callMock.mockClear()
    await expect(
      invoke(command, flagMap({ run: 'run_1', from: 'term_sibling' }))
    ).rejects.toMatchObject({ code: 'consumer_fenced' })
    expect(callMock).not.toHaveBeenCalled()
  })
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

  it('keeps the identity-less refusal, without --from advice, for a child that has no id', async () => {
    setEnv({ ORCA_STRUCTURED_SESSION: '1' })

    await expect(invoke('reply', flagMap({ id: 'msg_1', body: 'b' }))).rejects.toMatchObject({
      code: 'no_active_sender_terminal',
      message: expect.not.stringContaining('Pass --from')
    })
    expect(getTerminalHandleMock).not.toHaveBeenCalled()
    expect(callMock).not.toHaveBeenCalled()
  })
})

describe('a host refusal of the session', () => {
  const WORKER_GONE = new RuntimeRpcFailureError({
    id: 'rpc_1',
    ok: false,
    error: {
      code: 'session_caller_not_live',
      message: `Agent session ${SESSION} is a structured worker whose worker identity this host no longer has, so it cannot act in orchestration. No effects were applied.`,
      data: { effectsApplied: false }
    },
    _meta: { runtimeId: 'runtime_1' }
  })

  it.each(['check', 'run-current', 'worker-list'])(
    'surfaces from %s verbatim, never widened, retried or turned into a terminal guess',
    async (command) => {
      asSessionWithInheritedPane()
      callMock.mockRejectedValue(WORKER_GONE)

      await expect(invoke(command, flagMap({}))).rejects.toBe(WORKER_GONE)
      expect(getTerminalHandleMock).not.toHaveBeenCalled()
      expect(formatCliError(WORKER_GONE)).toBe(WORKER_GONE.message)
    }
  )
})

describe('the orchestration envelope', () => {
  it('carries the injected id beside whatever terminal evidence the process also has', () => {
    const envelope = createOrchestrationCompatibilityEnvelope({
      ORCA_AGENT_SESSION_ID: ` ${SESSION} `,
      ORCA_TERMINAL_HANDLE: 'term_inherited_pane'
    })

    expect(envelope.orchestrationCompatibilityEvidence).toEqual({
      terminalHandle: 'term_inherited_pane',
      agentSessionId: SESSION
    })
  })

  it('claims no session without an injected id', () => {
    expect(
      createOrchestrationCompatibilityEnvelope({ ORCA_AGENT_SESSION_ID: '  ' })
        .orchestrationCompatibilityEvidence
    ).toBeUndefined()
  })
})

describe('which flag names the caller, declared on every spec', () => {
  const ORCHESTRATION_SPECS = COMMAND_SPECS.filter((spec) => spec.path[0] === 'orchestration')

  const callerFlagVerbs = ORCHESTRATION_SPECS.flatMap((spec) =>
    (['from', 'terminal'] as const)
      .filter((flag) => spec.identityFlagRoles?.[flag] === 'caller')
      .map((flag) => ({ command: spec.path[1] ?? '', flag }))
  )

  it.each(callerFlagVerbs)(
    '$command refuses --$flag naming another caller, before any request',
    async ({ command, flag }) => {
      asSessionWithInheritedPane()
      await expect(
        invoke(command, flagMap({ ...EVERY_REQUIRED_FLAG, [flag]: 'term_sibling' }))
      ).rejects.toMatchObject({ code: 'consumer_fenced' })
      expect(callMock).not.toHaveBeenCalled()
      expect(getTerminalHandleMock).not.toHaveBeenCalled()
    }
  )
})
