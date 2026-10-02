import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorktreeWithNameRetry } from './worktree-create-retry'
import type { RpcClient } from '../transport/rpc-client'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { LogicalClientCutoverError } from '../transport/stable-logical-rpc-client'
import {
  AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS,
  AGENT_SESSION_OPERATION_FUTURE_SKEW_MS
} from '../../../src/shared/agent-session-host-authority'
import { setStructuredAgentSessionHost } from '../../../src/main/native-chat/agent-session-wire/structured-agent-session-registry'
import type { StructuredAgentSessionHost } from '../../../src/main/native-chat/agent-session-wire/structured-agent-session-host'
import type { AgentSessionRecordStore } from '../../../src/main/runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../../src/main/runtime/agent-session-record-store-test-harness'
import type { OrcaRuntimeService } from '../../../src/main/runtime/orca-runtime'
import { RpcDispatcher } from '../../../src/main/runtime/rpc/dispatcher'
import { runtimeStub } from '../../../src/main/runtime/rpc/methods/agent-launch.test-fixture'
import {
  AGENT_LAUNCH_REPLAY_REQUIRED_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_RUNTIME_CAPABILITY
} from '../../../src/shared/agent-launch-runtime-capability'
import {
  launchAgentInExistingWorkspace,
  reserveMobileAgentLaunch
} from '../session/mobile-existing-agent-launch'

const createStructuredSession = vi.fn()
vi.mock('../../../src/main/runtime/rpc/methods/structured-agent-session-create', () => ({
  createStructuredAgentSessionForWorktree: (...args: unknown[]) => createStructuredSession(...args)
}))
const { AGENT_LAUNCH_METHODS } = await import('../../../src/main/runtime/rpc/methods/agent-launch')

let directory: string
let store: AgentSessionRecordStore

beforeEach(async () => {
  createStructuredSession.mockReset()
  createStructuredSession.mockResolvedValue({ ok: true, value: { sessionId: 'session-1' } })
  directory = await mkdtemp(join(tmpdir(), 'orca-mobile-launch-replay-'))
  store = await openTestAgentSessionRecordStore(directory)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the launch reads only deps.store; structured session creation is the injected boundary above.
  setStructuredAgentSessionHost({ deps: { store } } as unknown as StructuredAgentSessionHost)
})

afterEach(async () => {
  vi.restoreAllMocks()
  setStructuredAgentSessionHost(null)
  await rm(directory, { recursive: true, force: true })
})

function mobileLaunch(
  args: {
    loseFirstReplyAfterMs?: number
    replay?: boolean
    restartAfterReply?: boolean
    replyLoss?: 'cutover' | 'timeout'
  } = {}
) {
  const runtime = { ...runtimeStub(), getRuntimeId: () => 'runtime-1' }
  const runtimeAfterRestart = { ...runtimeStub(), getRuntimeId: () => 'runtime-2' }
  const dispatchers = [runtime, runtimeAfterRestart].map(
    (host) =>
      new RpcDispatcher({
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture implements the launch handler and dispatcher metadata dependencies.
        runtime: host as unknown as OrcaRuntimeService,
        methods: AGENT_LAUNCH_METHODS
      })
  )
  const operationId = `${Date.now()}-000000000000000000000000000000aa`
  const attempts: unknown[] = []
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mobile retry loop reaches only these transport members; requests use the real host dispatcher.
  const client = {
    getState: () => 'connected',
    sendRequest: async (method: string, params: unknown) => {
      attempts.push(params)
      const dispatcher = dispatchers[args.restartAfterReply && attempts.length > 1 ? 1 : 0]!
      const response = await dispatcher.dispatch({
        id: `request-${attempts.length}`,
        authToken: 'token',
        method,
        params
      })
      if (attempts.length === 1 && args.loseFirstReplyAfterMs !== undefined) {
        const later = Date.now() + args.loseFirstReplyAfterMs
        vi.spyOn(Date, 'now').mockReturnValue(later)
        if (args.replyLoss === 'timeout') {
          throw markRpcDeliveryUnknown(new Error('Request timed out'))
        }
        throw new LogicalClientCutoverError()
      }
      return response
    }
  } as unknown as RpcClient
  const result = createWorktreeWithNameRetry({
    client,
    baseName: 'otter',
    buildParams: (name) => ({ repo: 'id:repo-1', name }),
    worktreeCreateIdempotency: { dedupeTtlMs: 60_000 },
    agentLaunch: { agent: 'claude', supported: { replay: args.replay !== false } },
    mintLaunchOperationId: () => operationId
  })
  return { runtime, runtimeAfterRestart, attempts, operationId, result }
}

describe('mobile launch retries through the host ledger', () => {
  it('does not replay an unnamed launch after an older host loses its in-memory receipt', async () => {
    const launch = mobileLaunch({
      replay: false,
      restartAfterReply: true,
      loseFirstReplyAfterMs: 1
    })

    const outcome = await launch.result.catch((error: unknown) => error)
    expect(
      launch.runtime.createManagedWorktree.mock.calls.length +
        launch.runtimeAfterRestart.createManagedWorktree.mock.calls.length
    ).toBe(1)
    expect(outcome).toBeInstanceOf(LogicalClientCutoverError)
    expect(launch.runtime.createManagedWorktree).toHaveBeenCalledTimes(1)
    expect(launch.runtimeAfterRestart.createManagedWorktree).not.toHaveBeenCalled()
    expect(createStructuredSession).toHaveBeenCalledTimes(1)
    expect(launch.attempts).toHaveLength(1)
  })

  it.each([
    'agent_session_operation_capacity',
    'agent_session_operation_invalid',
    'agent_session_operation_expired'
  ])('does not create another workspace after a nested %s refusal', async (code) => {
    createStructuredSession.mockResolvedValue({ ok: false, refusal: { code, message: code } })
    const launch = mobileLaunch()

    await expect(launch.result).resolves.toEqual({ error: 'agent_session_operation_unknown' })
    expect(launch.runtime.createManagedWorktree).toHaveBeenCalledTimes(1)
    expect(launch.attempts).toHaveLength(1)
    expect(store.listOperationRows()[0]?.outcome.status).toBe('unknown')
  })

  it('keeps the operation identity after its receipt expires during a lost reply', async () => {
    const launch = mobileLaunch({
      loseFirstReplyAfterMs:
        AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS + AGENT_SESSION_OPERATION_FUTURE_SKEW_MS + 1
    })

    await expect(launch.result).resolves.toEqual({ error: 'agent_session_operation_expired' })
    expect(launch.runtime.createManagedWorktree).toHaveBeenCalledTimes(1)
    expect(createStructuredSession).toHaveBeenCalledTimes(1)
    expect(launch.attempts).toHaveLength(2)
  })

  it('replays a lost reply beyond the legacy cache window without creating again', async () => {
    const launch = mobileLaunch({ loseFirstReplyAfterMs: 61_000 })

    await expect(launch.result).resolves.toEqual({ worktreeId: 'wt-new', name: 'otter' })
    expect(launch.runtime.createManagedWorktree).toHaveBeenCalledTimes(1)
    expect(createStructuredSession).toHaveBeenCalledTimes(1)
    expect(launch.attempts).toHaveLength(2)
    expect(launch.attempts[1]).toEqual(launch.attempts[0])
    expect(launch.runtime.dedupeWorktreeCreate).not.toHaveBeenCalled()
  })

  it('recovers a named launch whose reply timed out on a connected transport', async () => {
    const launch = mobileLaunch({ loseFirstReplyAfterMs: 10 * 60_000, replyLoss: 'timeout' })

    await expect(launch.result).resolves.toEqual({ worktreeId: 'wt-new', name: 'otter' })
    expect(launch.runtime.createManagedWorktree).toHaveBeenCalledTimes(1)
    expect(createStructuredSession).toHaveBeenCalledTimes(1)
    expect(launch.attempts).toHaveLength(2)
    expect(launch.attempts[1]).toEqual(launch.attempts[0])
  })
})

describe('a + menu launch into an open workspace', () => {
  it('reaches the host with the pane it reserved, once, across a lost reply', async () => {
    const runtime = { ...runtimeStub(), getRuntimeId: () => 'runtime-1' }
    const dispatcher = new RpcDispatcher({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture implements the launch handler and dispatcher metadata dependencies.
      runtime: runtime as unknown as OrcaRuntimeService,
      methods: AGENT_LAUNCH_METHODS
    })
    const attempts: unknown[] = []
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the replay loop reaches only these transport members; requests use the real host dispatcher.
    const client = {
      getState: () => 'connected',
      sendRequest: async (method: string, params: unknown) => {
        attempts.push(params)
        const response = await dispatcher.dispatch({
          id: `request-${attempts.length}`,
          authToken: 'token',
          method,
          params
        })
        if (attempts.length === 1) {
          throw markRpcDeliveryUnknown(new Error('Request timed out'))
        }
        return response
      }
    } as unknown as RpcClient
    const reservation = reserveMobileAgentLaunch('aider')

    const launched = await launchAgentInExistingWorkspace({
      client,
      hostCapabilities: [
        AGENT_LAUNCH_RUNTIME_CAPABILITY,
        AGENT_LAUNCH_REPLAY_REQUIRED_RUNTIME_CAPABILITY
      ],
      worktreeId: 'wt-7',
      agent: 'aider',
      reservation
    })

    expect(launched).toMatchObject({
      kind: 'launched',
      result: { outcome: { kind: 'terminal', handle: 'term_1' } }
    })
    // The replay carries the same ids, so the host answers it from its ledger.
    expect(attempts).toHaveLength(2)
    expect(attempts[1]).toEqual(attempts[0])
    expect(runtime.createTerminal).toHaveBeenCalledTimes(1)
    expect(runtime.createTerminal.mock.calls[0]![1]).toMatchObject({
      tabId: reservation.pane.tabId,
      leafId: reservation.pane.leafId,
      requireFreshPane: true
    })
  })

  it('reaches the host with a chat reservation its schema accepts', async () => {
    const runtime = { ...runtimeStub(), getRuntimeId: () => 'runtime-1' }
    const dispatcher = new RpcDispatcher({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture implements the launch handler and dispatcher metadata dependencies.
      runtime: runtime as unknown as OrcaRuntimeService,
      methods: AGENT_LAUNCH_METHODS
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the launch reaches only these transport members; requests use the real host dispatcher.
    const client = {
      getState: () => 'connected',
      sendRequest: async (method: string, params: unknown) =>
        dispatcher.dispatch({ id: 'request-1', authToken: 'token', method, params })
    } as unknown as RpcClient
    const reservation = reserveMobileAgentLaunch('claude')

    const launched = await launchAgentInExistingWorkspace({
      client,
      hostCapabilities: [
        AGENT_LAUNCH_RUNTIME_CAPABILITY,
        AGENT_LAUNCH_REPLAY_REQUIRED_RUNTIME_CAPABILITY
      ],
      worktreeId: 'wt-7',
      agent: 'claude',
      reservation
    })

    expect(reservation.sessionId).toMatch(/^claude_/)
    expect(launched).toMatchObject({ kind: 'launched' })
  })
})
