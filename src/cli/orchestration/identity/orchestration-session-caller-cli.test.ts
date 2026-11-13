// Inherited pane identity and an available sibling must never override the injected session caller.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.hoisted(() => vi.fn())
const getTerminalHandleMock = vi.hoisted(() => vi.fn())

vi.mock('../../output/command-result-output', () => ({ printResult: vi.fn() }))
vi.mock('../../terminals/terminal-selector', () => ({ getTerminalHandle: getTerminalHandleMock }))

import { ORCHESTRATION_HANDLERS } from '../orchestration-handlers'
import { findCommandSpec } from '../../arguments/args'
import { COMMAND_SPECS } from '../../specs/index'
import { refuseConflictingSessionCallerFlags } from './session-caller-flags'
import { createOrchestrationCompatibilityEnvelope } from './orchestration-compatibility-envelope'

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

/** dispatch-show is excluded: its --from fills preview text rather than naming the caller. */

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

describe('the identity a session presents', () => {
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
