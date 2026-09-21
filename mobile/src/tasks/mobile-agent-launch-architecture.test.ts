import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentSessionRecordStore } from '../../../src/main/runtime/agent-session-record-store'
import { OrcaRuntimeRpcServer } from '../../../src/main/runtime/runtime-rpc'
import { DeviceRegistry } from '../../../src/main/runtime/device-registry'
import type { AuthenticatedMobileSocket } from '../../../src/main/runtime/rpc/mobile-socket-wiring'
import { RpcDispatcher } from '../../../src/main/runtime/rpc/dispatcher'
import { AgentLaunch } from '../../../src/main/runtime/rpc/methods/agent-launch-schemas'
import { runtimeStub } from '../../../src/main/runtime/rpc/methods/agent-launch.test-fixture'
import { setStructuredAgentSessionHost } from '../../../src/main/native-chat/agent-session-wire/structured-agent-session-registry'
import type { StructuredAgentSessionHost } from '../../../src/main/native-chat/agent-session-wire/structured-agent-session-host'
import type { OrcaRuntimeService } from '../../../src/main/runtime/orca-runtime'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { createStableLogicalRpcClient } from '../transport/stable-logical-rpc-client'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import { WorktreeCreateCollisionError } from '../../../src/shared/new-workspace/worktree-create-collision'
import { createWorktreeWithNameRetry } from './worktree-create-retry'
import { readNewWorktreeRuntimeCapabilities } from './worktree-create-capability'
import {
  AGENT_LAUNCH_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_REPLAY_REQUIRED_RUNTIME_CAPABILITY
} from '../../../src/shared/protocol-version'

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
  directory = await mkdtemp(join(tmpdir(), 'orca-launch-architecture-'))
  store = await AgentSessionRecordStore.open({ directory, hostId: 'local' })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the launch reads deps.store; session creation is injected above.
  setStructuredAgentSessionHost({ deps: { store } } as unknown as StructuredAgentSessionHost)
})

afterEach(async () => {
  setStructuredAgentSessionHost(null)
  await rm(directory, { recursive: true, force: true })
})

function scenario(
  options: {
    replacement?: 'legacy' | 'current'
    loss?: 'cutover' | 'timeout'
    collision?: boolean
  } = {}
) {
  const runtime = { ...runtimeStub(), getRuntimeId: () => 'runtime-1' }
  const replacement = { ...runtimeStub(), getRuntimeId: () => 'runtime-2' }
  if (options.collision) {
    runtime.createManagedWorktree.mockRejectedValueOnce(
      new WorktreeCreateCollisionError('Branch "otter" already exists locally.')
    )
  }
  const dispatchers = [runtime, replacement].map(
    (host, index) =>
      new RpcDispatcher({
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies the methods reached by the real launch handler.
        runtime: host as unknown as OrcaRuntimeService,
        methods:
          index === 0 || options.replacement === 'current'
            ? AGENT_LAUNCH_METHODS
            : AGENT_LAUNCH_METHODS.filter((method) => method.name === 'agent.launch').map(
                (method) => ({
                  ...method,
                  // Older hosts accept the method but strip this optional field before running it.
                  params: AgentLaunch.omit({ operationId: true })
                })
              )
      })
  )
  let sent = 0
  let minted = 0
  let rejectFirst: ((error: Error) => void) | undefined
  let directReplacement = false
  const physical = (index: number): RpcClient => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the logical client reaches these transport methods; each mutation uses the production dispatcher.
    return {
      getState: () => 'connected',
      onStateChange: () => () => {},
      close: () => rejectFirst?.(markRpcDeliveryUnknown(new Error('Connection lost'))),
      sendRequest: async (method: string, params: unknown) => {
        if (method === 'status.get') {
          return {
            id: 'status',
            ok: true,
            result: {
              capabilities:
                index === 0
                  ? [
                      AGENT_LAUNCH_RUNTIME_CAPABILITY,
                      AGENT_LAUNCH_REPLAY_REQUIRED_RUNTIME_CAPABILITY
                    ]
                  : [AGENT_LAUNCH_RUNTIME_CAPABILITY]
            },
            _meta: { runtimeId: `runtime-${index + 1}` }
          }
        }
        sent += 1
        const response = await new Promise<RpcResponse>((resolve, reject) => {
          void dispatchers[directReplacement ? 1 : index]!.dispatchStreaming(
            {
              id: `request-${sent}`,
              authToken: 'token',
              method,
              params
            },
            (reply) => resolve(JSON.parse(reply)),
            {
              clientKind: 'mobile',
              pairedDeviceId: 'paired-device-1',
              clientId: `credential-${index}`,
              clientCapabilities: [AGENT_LAUNCH_RUNTIME_CAPABILITY]
            }
          ).catch(reject)
        })
        if (options.replacement && sent === 1) {
          if (options.loss === 'timeout') {
            directReplacement = true
            throw markRpcDeliveryUnknown(new Error('Request timed out'))
          }
          return new Promise((_, reject) => {
            rejectFirst = reject
            void client.migrateTo(physical(1), 'relay')
          })
        }
        return response
      }
    } as unknown as RpcClient
  }
  const client = createStableLogicalRpcClient(physical(0), 'lan')
  const result = readNewWorktreeRuntimeCapabilities(client)
    .then((support) =>
      createWorktreeWithNameRetry({
        client,
        baseName: 'otter',
        buildParams: (name) => ({ repo: 'id:repo-1', name }),
        worktreeCreateIdempotency: { dedupeTtlMs: 60_000 },
        agentLaunch: { agent: 'claude', supported: support.agentLaunch },
        mintLaunchOperationId: () => `${Date.now()}-${(++minted).toString(16).padStart(32, '0')}`
      })
    )
    .finally(() => client.close())
  return { runtime, replacement, result }
}

describe('mobile launch retry authority', () => {
  it('admits a paired mobile create through the WebSocket method allowlist', async () => {
    const runtime = {
      ...runtimeStub(),
      getRuntimeId: () => 'runtime-1',
      configureNotificationDismissalStore: () => {}
    }
    const server = new OrcaRuntimeRpcServer({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture supplies the constructor and launch method dependencies.
      runtime: runtime as unknown as OrcaRuntimeService,
      userDataPath: directory,
      enableWebSocket: false
    })
    server['deviceRegistry'] = new DeviceRegistry(directory)
    const mobile = server['deviceRegistry'].addDevice('test-phone', 'mobile')
    const replies: RpcResponse[] = []
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: with no pairing provider or physical socket, this admission path reads only clientCapabilities.
    const authenticatedSocket = {
      clientCapabilities: [AGENT_LAUNCH_RUNTIME_CAPABILITY]
    } as unknown as AuthenticatedMobileSocket
    await server['handleWebSocketMessage'](
      JSON.stringify({
        id: 'mobile-create',
        deviceToken: mobile.token,
        method: 'agent.launchReplay',
        params: {
          operationId: `${Date.now()}-${'a'.repeat(32)}`,
          agent: 'claude',
          target: { kind: 'create-worktree', create: { repo: 'id:repo-1', name: 'otter' } }
        }
      }),
      (reply) => replies.push(JSON.parse(reply)),
      () => {},
      undefined,
      undefined,
      mobile.token,
      authenticatedSocket
    )
    expect(replies).toEqual([
      expect.objectContaining({
        ok: true,
        result: expect.objectContaining({ worktreeId: 'wt-new' })
      })
    ])
    expect(runtime.createManagedWorktree).toHaveBeenCalledTimes(1)
    expect(store.listOperationRows()[0]?.callerKey).toBe(mobile.deviceId)
  })

  it('rejects an unnamed replay request before workspace creation', async () => {
    const runtime = { ...runtimeStub(), getRuntimeId: () => 'runtime-1' }
    const dispatcher = new RpcDispatcher({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture implements the launch handler dependencies.
      runtime: runtime as unknown as OrcaRuntimeService,
      methods: AGENT_LAUNCH_METHODS
    })
    const response = await dispatcher.dispatch({
      id: 'missing-operation',
      authToken: 'token',
      method: 'agent.launchReplay',
      params: {
        agent: 'claude',
        target: { kind: 'create-worktree', create: { repo: 'id:repo-1', name: 'otter' } }
      }
    })
    expect(response.ok).toBe(false)
    expect(runtime.createManagedWorktree).not.toHaveBeenCalled()
    expect(createStructuredSession).not.toHaveBeenCalled()
  })

  it('shares one durable receipt across entry points and a reopened store', async () => {
    const runtime = { ...runtimeStub(), getRuntimeId: () => 'runtime-1' }
    const dispatcher = new RpcDispatcher({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture implements the launch handler dependencies.
      runtime: runtime as unknown as OrcaRuntimeService,
      methods: AGENT_LAUNCH_METHODS
    })
    const request = {
      id: 'same-operation',
      authToken: 'token',
      method: 'agent.launch',
      params: {
        operationId: `${Date.now()}-${'e'.repeat(32)}`,
        agent: 'claude',
        target: { kind: 'create-worktree', create: { repo: 'id:repo-1', name: 'otter' } }
      }
    }
    const first = await dispatcher.dispatch(request)
    expect(first.ok).toBe(true)
    store = await AgentSessionRecordStore.open({ directory, hostId: 'local' })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: launch admission reads only deps.store from the installed host.
    setStructuredAgentSessionHost({ deps: { store } } as unknown as StructuredAgentSessionHost)
    await expect(
      dispatcher.dispatch({ ...request, method: 'agent.launchReplay' })
    ).resolves.toEqual(first)
    expect(runtime.createManagedWorktree).toHaveBeenCalledTimes(1)
    expect(createStructuredSession).toHaveBeenCalledTimes(1)
    expect(store.listOperationRows()).toHaveLength(1)
  })

  it('does not duplicate when a replacement host strips operationId', async () => {
    const launch = scenario({ replacement: 'legacy' })
    await expect(launch.result).resolves.toMatchObject({
      error: expect.stringContaining('Unknown method')
    })
    expect(
      launch.runtime.createManagedWorktree.mock.calls.length +
        launch.replacement.createManagedWorktree.mock.calls.length
    ).toBe(1)
    expect(createStructuredSession).toHaveBeenCalledTimes(1)
  })

  it('replays an exhausted collision after restart without searching names again', async () => {
    const runtime = { ...runtimeStub(), getRuntimeId: () => 'runtime-1' }
    runtime.createManagedWorktree.mockRejectedValueOnce(
      new WorktreeCreateCollisionError('Branch "otter" already exists locally.')
    )
    const dispatcher = new RpcDispatcher({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture implements the launch handler dependencies.
      runtime: runtime as unknown as OrcaRuntimeService,
      methods: AGENT_LAUNCH_METHODS
    })
    const request = {
      id: 'exhausted-operation',
      authToken: 'token',
      method: 'agent.launchReplay',
      params: {
        operationId: `${Date.now()}-${'f'.repeat(32)}`,
        agent: 'claude',
        target: { kind: 'create-worktree', create: { repo: 'id:repo-1', name: 'otter' } }
      }
    }
    await expect(dispatcher.dispatch(request)).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'worktree_create_collision',
        message: 'Branch "otter" already exists locally.'
      }
    })
    store = await AgentSessionRecordStore.open({ directory, hostId: 'local' })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: launch admission reads only deps.store from the installed host.
    setStructuredAgentSessionHost({ deps: { store } } as unknown as StructuredAgentSessionHost)
    await expect(dispatcher.dispatch(request)).resolves.toMatchObject({
      ok: false,
      error: { code: 'worktree_create_collision' }
    })
    expect(runtime.createManagedWorktree).toHaveBeenCalledTimes(1)
    expect(createStructuredSession).not.toHaveBeenCalled()
  })

  it('does not interpret a nested refusal message as a fresh workspace candidate', async () => {
    createStructuredSession.mockResolvedValueOnce({
      ok: false,
      refusal: {
        code: 'agent_session_operation_unknown',
        message: 'Branch "setup" already exists.'
      }
    })
    const launch = scenario()
    await expect(launch.result).resolves.toEqual({ error: 'agent_session_operation_unknown' })
    expect(launch.runtime.createManagedWorktree).toHaveBeenCalledTimes(1)
    expect(createStructuredSession).toHaveBeenCalledTimes(1)
  })

  it('refuses an older receiver reached after a connected timeout', async () => {
    const launch = scenario({ replacement: 'legacy', loss: 'timeout' })
    await expect(launch.result).resolves.toMatchObject({
      error: expect.stringContaining('Unknown method')
    })
    expect(launch.runtime.createManagedWorktree).toHaveBeenCalledTimes(1)
    expect(launch.replacement.createManagedWorktree).not.toHaveBeenCalled()
  })

  it('replays through a current replacement under the same paired-device identity', async () => {
    const launch = scenario({ replacement: 'current' })
    await expect(launch.result).resolves.toEqual({ worktreeId: 'wt-new', name: 'otter' })
    expect(launch.runtime.createManagedWorktree).toHaveBeenCalledTimes(1)
    expect(launch.replacement.createManagedWorktree).not.toHaveBeenCalled()
    expect(createStructuredSession).toHaveBeenCalledTimes(1)
  })

  it('leaves exhausted name selection with the host and records a definitive failure', async () => {
    const launch = scenario({ collision: true })
    await expect(launch.result).resolves.toEqual({
      error: 'Branch "otter" already exists locally.'
    })
    expect(launch.runtime.createManagedWorktree).toHaveBeenCalledTimes(1)
    expect(createStructuredSession).not.toHaveBeenCalled()
    expect(store.listOperationRows()[0]?.outcome).toMatchObject({
      status: 'failed',
      code: 'worktree_create_collision'
    })
  })

  it.each([
    'agent_launch_unsupported',
    'agent_launch_replay_unsupported',
    'method_not_found',
    'worktree_create_collision'
  ])('does not downgrade or rename after nested %s text', async (message) => {
    createStructuredSession.mockResolvedValueOnce({
      ok: false,
      refusal: { code: 'agent_session_operation_unknown', message }
    })
    const launch = scenario()
    await expect(launch.result).resolves.toEqual({ error: 'agent_session_operation_unknown' })
    expect(launch.runtime.createManagedWorktree).toHaveBeenCalledTimes(1)
    expect(createStructuredSession).toHaveBeenCalledTimes(1)
  })
})
