import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  CodexAppServerConnection,
  CodexAppServerConnectionHandlers,
  openCodexAppServerConnection
} from '../codex/codex-app-server-connection'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams,
  hostTestMessage
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'

describe('structured session runtime provider-exit wiring', () => {
  let root: string | null = null
  let operations = 0

  const operationId = (): string => `${Date.now()}-${(++operations).toString(16).padStart(32, '0')}`

  afterEach(async () => {
    await stopStructuredAgentSessionRuntime()
    if (root) {
      await rm(root, { recursive: true, force: true })
      root = null
    }
  })

  it('does not respawn after a provider exit, and the next message starts a new child', async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-runtime-provider-exit-'))
    operations = 0
    const connections: {
      connection: CodexAppServerConnection
      handlers: CodexAppServerConnectionHandlers
    }[] = []
    let turn = 0
    const openConnection = (async (_launch, handlers = {}) => {
      const connection: CodexAppServerConnection = {
        pid: 4321,
        closed: false,
        request: async (method, params) => {
          if (method === 'thread/start') {
            return { thread: { id: 'thread-runtime-exit' } }
          }
          if (method === 'thread/resume') {
            return { thread: { id: (params as { threadId: string }).threadId } }
          }
          if (method === 'turn/start') {
            return { turn: { id: `turn-${++turn}` } }
          }
          if (method === 'model/list') {
            return {
              data: [
                {
                  model: 'gpt-test',
                  displayName: 'GPT Test',
                  hidden: false,
                  supportedReasoningEfforts: [],
                  defaultReasoningEffort: null,
                  isDefault: true
                }
              ],
              nextCursor: null
            }
          }
          return {}
        },
        notify: () => {},
        respond: () => {},
        respondWithError: () => {},
        close: async () => true
      }
      connections.push({ connection, handlers })
      return connection
    }) as typeof openCodexAppServerConnection
    const host = await ensureStructuredAgentSessionHost({
      stateDirectory: root,
      hostId: 'local',
      claimKeyId: 'key-1',
      resolveWorkspacePath: async () => root!,
      resolveClaudeAuthPolicy: () => ({ stripAuthEnv: true }),
      resolveCodexCommand: () => 'codex',
      resolveEnvironment: async () => ({ PATH: process.env.PATH }),
      openCodexConnection: openConnection,
      readProcessStartTime: async () => 1_700_000_000_000
    })
    const attachParams = hostTestAttachParams(null, { providerHandle: undefined })
    attachParams.envelope.clientOperationId = operationId()
    const attached = await host.attach({ callerKey: 'runtime-test' }, attachParams)
    if (!attached.ok) {
      throw new Error(
        JSON.stringify({ refusal: attached.refusal, connections: connections.length })
      )
    }
    const exited = connections[0]
    exited?.handlers.onExit?.(new Error('scripted provider exit'))
    await vi.waitFor(() =>
      expect(host.deps.store.getRecord(SESSION)?.lease.claimStatus).toBe('released')
    )
    // Nothing restarts the child on its own; the exit is shown and the chat waits for a send.
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
    expect(connections).toHaveLength(1)
    const recoveredFence = host.deps.store.getRecord(SESSION)?.lease.runtimeFence
    if (recoveredFence === undefined) {
      throw new Error('released lease omitted its fence')
    }
    const body = hostTestMessage('continue with a distinct message')
    const envelope = {
      sessionId: SESSION,
      clientOperationId: operationId(),
      expectedRuntimeFence: recoveredFence,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: SESSION,
        fields: { body }
      })
    }

    // `pending` is this send's real answer now, not a weaker one: admission settles
    // when the transport takes the frame, and identity arrives later on the
    // provider's echo. What proves the message reached the REACQUIRED provider is
    // the turn it starts below, which is what this test exists to check.
    await expect(
      host.send({ callerKey: 'runtime-test' }, { envelope, body })
    ).resolves.toMatchObject({ ok: true, value: { submission: { dispatchState: 'pending' } } })
    // The send answers at acceptance; the delivery loop starts a new child and hands it over.
    await vi.waitFor(() => expect(connections).toHaveLength(2))
    await vi.waitFor(() => expect(turn).toBe(1))
  })

  it('does not reacquire when the production exit callback comes from a requested close', async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-runtime-requested-close-'))
    operations = 0
    const connections: {
      connection: CodexAppServerConnection
      handlers: CodexAppServerConnectionHandlers
    }[] = []
    const openConnection = (async (_launch, handlers = {}) => {
      const connection: CodexAppServerConnection = {
        pid: 4321,
        closed: false,
        request: async (method, params) => {
          if (method === 'thread/start') {
            return { thread: { id: 'thread-runtime-close' } }
          }
          if (method === 'thread/resume') {
            return { thread: { id: (params as { threadId: string }).threadId } }
          }
          if (method === 'turn/start') {
            return { turn: { id: 'turn-close' } }
          }
          if (method === 'model/list') {
            return {
              data: [
                {
                  model: 'gpt-test',
                  displayName: 'GPT Test',
                  hidden: false,
                  supportedReasoningEfforts: [],
                  defaultReasoningEffort: null,
                  isDefault: true
                }
              ],
              nextCursor: null
            }
          }
          return {}
        },
        notify: () => {},
        respond: () => {},
        respondWithError: () => {},
        close: async () => {
          handlers.onExit?.(new Error('requested close'))
          return true
        }
      }
      connections.push({ connection, handlers })
      return connection
    }) as typeof openCodexAppServerConnection
    const host = await ensureStructuredAgentSessionHost({
      stateDirectory: root,
      hostId: 'local',
      claimKeyId: 'key-1',
      resolveWorkspacePath: async () => root!,
      resolveClaudeAuthPolicy: () => ({ stripAuthEnv: true }),
      resolveCodexCommand: () => 'codex',
      resolveEnvironment: async () => ({ PATH: process.env.PATH }),
      openCodexConnection: openConnection,
      readProcessStartTime: async () => 1_700_000_000_000
    })
    const attachParams = hostTestAttachParams(null, { providerHandle: undefined })
    attachParams.envelope.clientOperationId = operationId()
    const attached = await host.attach({ callerKey: 'runtime-test' }, attachParams)
    if (!attached.ok) {
      throw new Error(
        JSON.stringify({ refusal: attached.refusal, connections: connections.length })
      )
    }

    await stopStructuredAgentSessionRuntime()
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(connections).toHaveLength(1)
    expect(host.deps.store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'released',
      ownerProcess: null,
      handoffStage: null
    })

    const restarted = await ensureStructuredAgentSessionHost({
      stateDirectory: root,
      hostId: 'local',
      claimKeyId: 'key-1',
      resolveWorkspacePath: async () => root!,
      resolveClaudeAuthPolicy: () => ({ stripAuthEnv: true }),
      resolveCodexCommand: () => 'codex',
      resolveEnvironment: async () => ({ PATH: process.env.PATH }),
      openCodexConnection: openConnection,
      readProcessStartTime: async () => 1_700_000_000_000
    })
    await restarted.restoreStartupSessions()
    const history = await restarted.history({ sessionId: SESSION, direction: 'tail' })
    expect(history.ok && history.page.items.some((item) => item.body.kind === 'status')).toBe(false)
    expect(restarted.deps.store.getRecord(SESSION)?.providerHandleChain.at(-1)?.handle).toEqual({
      provider: 'codex',
      threadId: 'thread-runtime-close'
    })
  })

  it('waits for a start a send began before tearing down the runtime', async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-runtime-recovery-shutdown-'))
    let releaseRecovery!: () => void
    const recoveryReleased = new Promise<void>((resolve) => {
      releaseRecovery = resolve
    })
    const connections: {
      connection: CodexAppServerConnection
      handlers: CodexAppServerConnectionHandlers
    }[] = []
    let opens = 0
    const openConnection = (async (_launch, handlers = {}) => {
      opens += 1
      if (opens === 2) {
        await recoveryReleased
      }
      const connection: CodexAppServerConnection = {
        pid: 4321 + opens,
        closed: false,
        request: async (method, params) => {
          if (method === 'thread/start') {
            return { thread: { id: 'thread-runtime-shutdown' } }
          }
          if (method === 'thread/resume') {
            return { thread: { id: (params as { threadId: string }).threadId } }
          }
          if (method === 'turn/start') {
            return { turn: { id: 'turn-shutdown' } }
          }
          if (method === 'model/list') {
            return {
              data: [
                {
                  model: 'gpt-test',
                  displayName: 'GPT Test',
                  hidden: false,
                  supportedReasoningEfforts: [],
                  defaultReasoningEffort: null,
                  isDefault: true
                }
              ],
              nextCursor: null
            }
          }
          return {}
        },
        notify: () => {},
        respond: () => {},
        respondWithError: () => {},
        close: async () => true
      }
      connections.push({ connection, handlers })
      return connection
    }) as typeof openCodexAppServerConnection
    const host = await ensureStructuredAgentSessionHost({
      stateDirectory: root,
      hostId: 'local',
      claimKeyId: 'key-1',
      resolveWorkspacePath: async () => root!,
      resolveClaudeAuthPolicy: () => ({ stripAuthEnv: true }),
      resolveCodexCommand: () => 'codex',
      resolveEnvironment: async () => ({ PATH: process.env.PATH }),
      openCodexConnection: openConnection,
      readProcessStartTime: async () => 1_700_000_000_000
    })
    const attachParams = hostTestAttachParams(null, { providerHandle: undefined })
    attachParams.envelope.clientOperationId = operationId()
    const attached = await host.attach({ callerKey: 'runtime-test' }, attachParams)
    expect(attached.ok).toBe(true)
    connections[0]?.handlers.onExit?.(new Error('the first child exited'))
    await vi.waitFor(() =>
      expect(host.deps.store.getRecord(SESSION)?.lease.claimStatus).toBe('released')
    )
    const body = hostTestMessage('start again')
    await host.send(
      { callerKey: 'runtime-test' },
      {
        envelope: {
          sessionId: SESSION,
          clientOperationId: operationId(),
          expectedRuntimeFence: host.deps.store.getRecord(SESSION)?.lease.runtimeFence ?? 0,
          payloadFingerprint: computeAgentSessionPayloadFingerprint({
            method: 'agentSession.send',
            sessionId: SESSION,
            fields: { body }
          })
        },
        body
      }
    )
    // The send's start is still opening its connection when the quit begins.
    await vi.waitFor(() => expect(opens).toBe(2))

    let stopped = false
    const stopping = stopStructuredAgentSessionRuntime().then(() => {
      stopped = true
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(stopped).toBe(false)
    releaseRecovery()
    await stopping
    expect(stopped).toBe(true)
  })
  it('drains a final exit callback delivered by the adapter backstop and keeps the retry real', async () => {
    // The first stop refuses, so host eviction cannot prove the child gone and aborts with the
    // session still indexed. What finally stops it is `closeAll`, which delivers the exit
    // callback AFTER host teardown has already run.
    root = await mkdtemp(join(tmpdir(), 'orca-runtime-backstop-exit-'))
    operations = 0
    const connections: {
      connection: CodexAppServerConnection
      handlers: CodexAppServerConnectionHandlers
    }[] = []
    let closeAttempts = 0
    const openConnection: typeof openCodexAppServerConnection = async (_launch, handlers = {}) => {
      const connection: CodexAppServerConnection = {
        pid: 4321,
        closed: false,
        request: async (method, params) => {
          if (method === 'thread/start') {
            return { thread: { id: 'thread-runtime-backstop' } }
          }
          if (method === 'thread/resume') {
            return { thread: { id: (params as { threadId: string }).threadId } }
          }
          if (method === 'turn/start') {
            return { turn: { id: 'turn-backstop' } }
          }
          if (method === 'model/list') {
            return {
              data: [
                {
                  model: 'gpt-test',
                  displayName: 'GPT Test',
                  hidden: false,
                  supportedReasoningEfforts: [],
                  defaultReasoningEffort: null,
                  isDefault: true
                }
              ],
              nextCursor: null
            }
          }
          return {}
        },
        notify: () => {},
        respond: () => {},
        respondWithError: () => {},
        close: async () => {
          closeAttempts += 1
          if (closeAttempts === 1) {
            return false
          }
          handlers.onExit?.(new Error('adapter backstop close'))
          return true
        }
      }
      connections.push({ connection, handlers })
      return connection
    }
    const host = await ensureStructuredAgentSessionHost({
      stateDirectory: root,
      hostId: 'local',
      claimKeyId: 'key-1',
      resolveWorkspacePath: async () => root!,
      resolveClaudeAuthPolicy: () => ({ stripAuthEnv: true }),
      resolveCodexCommand: () => 'codex',
      resolveEnvironment: async () => ({ PATH: process.env.PATH }),
      openCodexConnection: openConnection,
      readProcessStartTime: async () => 1_700_000_000_000
    })
    const attachParams = hostTestAttachParams(null, { providerHandle: undefined })
    attachParams.envelope.clientOperationId = operationId()
    expect(await host.attach({ callerKey: 'runtime-test' }, attachParams)).toMatchObject({
      ok: true
    })

    await expect(stopStructuredAgentSessionRuntime()).rejects.toThrow()
    await new Promise<void>((resolve) => setImmediate(resolve))

    // The backstop, not host eviction, is what stopped the child.
    expect(closeAttempts).toBeGreaterThanOrEqual(2)
    // The callback it delivered neither reacquired nor wrote a technical row.
    expect(connections).toHaveLength(1)
    const history = await host.history({ sessionId: SESSION, direction: 'tail' })
    expect(history.ok && history.page.items.some((item) => item.body.kind === 'status')).toBe(false)

    // The aborted eviction left the session reachable, so the next teardown is a real retry.
    await stopStructuredAgentSessionRuntime()
    expect(host.deps.store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'released',
      ownerProcess: null,
      handoffStage: null
    })
  })
})
