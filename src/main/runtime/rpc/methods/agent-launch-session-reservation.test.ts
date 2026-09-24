/**
 * The chat session a caller reserves for the structured launch `agent.launch` creates.
 *
 * The caller mints the conversation's id so it knows which session it started before the reply
 * arrives. The outcome's `sessionId` says which session really exists.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computeAgentLaunchFingerprint } from '../../../../shared/agent-launch-operation'
import { AgentSessionRecordStore } from '../../agent-session-record-store'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcContext } from '../core'
import { RpcDispatcher } from '../dispatcher'
import {
  CAPABLE_CLIENT,
  STRUCTURED_PREFERENCE,
  methodNamed,
  rpcContext,
  runtimeStub,
  type AgentLaunchRuntimeStub as RuntimeStub
} from './agent-launch.test-fixture'

type StructuredCreateArgs = { envelope: { sessionId: string } }
type StructuredCreateResult =
  | { ok: true; value: { sessionId: string } }
  | { ok: false; refusal: { code: string; message: string } }

const createStructured = vi.hoisted(() =>
  vi.fn(async (args: StructuredCreateArgs): Promise<StructuredCreateResult> => ({
    ok: true,
    value: { sessionId: args.envelope.sessionId }
  }))
)

vi.mock('./structured-agent-session-create', () => ({
  createStructuredAgentSessionForWorktree: createStructured
}))

const { AGENT_LAUNCH_METHODS } = await import('./agent-launch')
const AGENT_LAUNCH = methodNamed(AGENT_LAUNCH_METHODS, 'agent.launch')
const AGENT_LAUNCH_REPLAY = methodNamed(AGENT_LAUNCH_METHODS, 'agent.launchReplay')

const SESSION_ID = 'claude_9b1deb4d_3b7d_4bad_9bdd_2b0d7b3dcb6d'
const TERMINAL_ONLY = {}
const EXISTING_LAUNCH = { agent: 'claude', target: { kind: 'existing', worktree: 'id:wt-7' } }
const CREATE_LAUNCH = {
  agent: 'claude',
  target: { kind: 'create-worktree', create: { repo: 'id:repo-1', name: 'task' } }
}
const TAKEN = { ok: false as const, refusal: { code: 'agent_session_conflict', message: 'taken' } }

async function launch(params: unknown, runtime: RuntimeStub, context: Partial<RpcContext> = {}) {
  const parsed = AGENT_LAUNCH.params.safeParse(params)
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? 'invalid')
  }
  return AGENT_LAUNCH.handler(parsed.data, rpcContext(runtime, { ...CAPABLE_CLIENT, ...context }))
}

function requestedSessionId(): string | undefined {
  return createStructured.mock.calls[0]?.[0].envelope.sessionId
}

beforeEach(() => {
  createStructured.mockClear()
})

describe('a launch the host settles as a chat', () => {
  it('creates the session under the id the caller reserved', async () => {
    const runtime = runtimeStub({ settings: STRUCTURED_PREFERENCE })

    const result = await launch({ ...EXISTING_LAUNCH, sessionId: SESSION_ID }, runtime)

    expect(requestedSessionId()).toBe(SESSION_ID)
    expect(result.outcome).toMatchObject({ kind: 'structured', sessionId: SESSION_ID })
  })

  it('mints its own id when the caller reserved none', async () => {
    const runtime = runtimeStub({ settings: STRUCTURED_PREFERENCE })

    await launch(EXISTING_LAUNCH, runtime)

    // Shaped like every other host-minted id: named for its agent, one token.
    expect(requestedSessionId()).toMatch(/^claude_[A-Za-z0-9_]+$/)
    expect(requestedSessionId()).not.toBe(SESSION_ID)
  })

  it('carries the reservation into a chat created with its workspace', async () => {
    const runtime = runtimeStub({ settings: STRUCTURED_PREFERENCE })

    await launch({ ...CREATE_LAUNCH, sessionId: SESSION_ID }, runtime)

    expect(requestedSessionId()).toBe(SESSION_ID)
  })
})

describe('a reserved session id that is already taken', () => {
  it('refuses the launch with its own code rather than an opaque refusal', async () => {
    createStructured.mockResolvedValueOnce(TAKEN)
    const runtime = runtimeStub({ settings: STRUCTURED_PREFERENCE })

    await expect(launch({ ...EXISTING_LAUNCH, sessionId: SESSION_ID }, runtime)).rejects.toThrow(
      'agent_launch_session_already_exists'
    )
  })

  it('does not fall back to a terminal over it', async () => {
    // A caller that named a taken session has a bug to see, not an agent in a different surface.
    createStructured.mockResolvedValueOnce(TAKEN)
    const runtime = runtimeStub({ settings: STRUCTURED_PREFERENCE })

    await expect(launch({ ...EXISTING_LAUNCH, sessionId: SESSION_ID }, runtime)).rejects.toThrow()
    expect(runtime.createTerminal).not.toHaveBeenCalled()
  })

  it('leaves a conflict on a host-minted id as it was', async () => {
    // Only a caller-named id makes the conflict the caller's answer.
    createStructured.mockResolvedValueOnce(TAKEN)
    const runtime = runtimeStub({ settings: STRUCTURED_PREFERENCE })

    await expect(launch(EXISTING_LAUNCH, runtime)).rejects.toThrow('taken')
  })
})

describe('a launch the host settles as a terminal', () => {
  it('creates no session and ignores the reservation', async () => {
    const runtime = runtimeStub({ settings: TERMINAL_ONLY })

    const result = await launch({ ...EXISTING_LAUNCH, sessionId: SESSION_ID }, runtime)

    expect(createStructured).not.toHaveBeenCalled()
    expect(result.outcome.kind).toBe('terminal')
  })
})

describe('the reservation at the wire', () => {
  it.each([
    ['too short', 'claude_'],
    ['a character outside the id alphabet', 'claude_9b1d:eb4d'],
    ['surrounding space', ` ${SESSION_ID}`],
    ['named for another agent', 'codex_9b1deb4d_3b7d_4bad_9bdd_2b0d7b3dcb6d'],
    ['more than one token', 'claude_9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d']
  ])('refuses a session id that is %s', (_, sessionId) => {
    expect(AGENT_LAUNCH.params.safeParse({ ...EXISTING_LAUNCH, sessionId }).success).toBe(false)
  })

  it('refuses a session id named for another agent on the replay method too', () => {
    const params = {
      ...EXISTING_LAUNCH,
      operationId: `${Date.now()}-000000000000000000000000000000dd`,
      sessionId: 'codex_9b1deb4d_3b7d_4bad_9bdd_2b0d7b3dcb6d'
    }
    expect(AGENT_LAUNCH_REPLAY.params.safeParse(params).success).toBe(false)
  })

  it('accepts a well-formed session id', () => {
    expect(
      AGENT_LAUNCH.params.safeParse({ ...EXISTING_LAUNCH, sessionId: SESSION_ID }).success
    ).toBe(true)
  })

  it('accepts a session id named for an agent whose name has a hyphen', () => {
    // Such an agent has no chat today, so the id is ignored on its terminal, as it is for any other.
    const params = {
      ...EXISTING_LAUNCH,
      agent: 'mimo-code',
      sessionId: 'mimo-code_9b1deb4d_3b7d_4bad_9bdd_2b0d7b3dcb6d'
    }
    expect(AGENT_LAUNCH.params.safeParse(params).success).toBe(true)
  })

  it('still refuses a hyphen after the agent name', () => {
    const params = {
      ...EXISTING_LAUNCH,
      agent: 'mimo-code',
      sessionId: 'mimo-code_9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'
    }
    expect(AGENT_LAUNCH.params.safeParse(params).success).toBe(false)
  })
})

describe('the reservation in the replay fingerprint', () => {
  const BASE = { agent: 'claude', target: { kind: 'existing' as const, worktree: 'wt-1' } }

  it('separates two launches that reserved different sessions', () => {
    expect(computeAgentLaunchFingerprint({ ...BASE, sessionId: SESSION_ID })).not.toBe(
      computeAgentLaunchFingerprint({ ...BASE, sessionId: 'claude_other_session_id' })
    )
  })

  it('leaves every digest without a reservation unchanged', () => {
    expect(computeAgentLaunchFingerprint({ ...BASE, sessionId: undefined })).toBe(
      computeAgentLaunchFingerprint(BASE)
    )
  })
})

describe('a taken session id under a named operation', () => {
  // The ledger admits against `Date.now()`, so the id must be dated now.
  const OPERATION_ID = `${Date.now()}-000000000000000000000000000000cc`
  let directory: string
  let store: AgentSessionRecordStore

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'orca-agent-launch-session-'))
    store = await AgentSessionRecordStore.open({ directory, hostId: 'local' })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: `deps.store` is the only member `agent.launch` reads, and a member it omits throws on call.
    setStructuredAgentSessionHost({ deps: { store } } as unknown as StructuredAgentSessionHost)
  })

  afterEach(async () => {
    setStructuredAgentSessionHost(null)
    await rm(directory, { recursive: true, force: true })
  })

  function outcomeOf(operationId: string) {
    return store.listOperationRows().find((row) => row.operationId === operationId)?.outcome
  }

  it('records the refusal as a failure, so a retry is answered rather than left unknown', async () => {
    createStructured.mockResolvedValueOnce(TAKEN)
    const params = { ...EXISTING_LAUNCH, sessionId: SESSION_ID, operationId: OPERATION_ID }

    await expect(launch(params, runtimeStub({ settings: STRUCTURED_PREFERENCE }))).rejects.toThrow(
      'agent_launch_session_already_exists'
    )
    expect(outcomeOf(OPERATION_ID)).toMatchObject({
      status: 'failed',
      code: 'agent_launch_session_already_exists'
    })

    const retry = runtimeStub({ settings: STRUCTURED_PREFERENCE })
    await expect(launch(params, retry)).rejects.toThrow('agent_launch_session_already_exists')
    expect(createStructured).toHaveBeenCalledTimes(1)
  })

  it('answers agent.launchReplay with the refusal code, not operation_unknown', async () => {
    createStructured.mockResolvedValueOnce(TAKEN)
    const runtime = runtimeStub({ settings: STRUCTURED_PREFERENCE })
    const dispatcher = new RpcDispatcher({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture implements every runtime method reached by agent.launch and dispatcher metadata.
      runtime: { ...runtime, getRuntimeId: () => 'runtime-1' } as unknown as OrcaRuntimeService,
      methods: AGENT_LAUNCH_METHODS
    })
    const params = AGENT_LAUNCH_REPLAY.params.parse({
      ...EXISTING_LAUNCH,
      sessionId: SESSION_ID,
      operationId: OPERATION_ID
    })

    const response = await dispatcher.dispatch({
      id: 'request-1',
      authToken: 'token',
      method: 'agent.launchReplay',
      params
    })

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'agent_launch_session_already_exists' }
    })
  })
})
