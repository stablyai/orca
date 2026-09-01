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

  it('reacquires through the production callback and accepts a distinct next message', async () => {
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
    await host.hold(SESSION, 'desktop-chat:1')
    const exitedFence = host.deps.store.getRecord(SESSION)?.lease.runtimeFence ?? 0
    const exited = connections[0]
    exited?.handlers.onExit?.(new Error('scripted provider exit'))

    await vi.waitFor(() => expect(connections).toHaveLength(2))
    const recoveredFence = host.deps.store.getRecord(SESSION)?.lease.runtimeFence
    expect(recoveredFence).toBeGreaterThan(exitedFence)
    if (recoveredFence === undefined) {
      throw new Error('recovered lease omitted its fence')
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

    await expect(
      host.send({ callerKey: 'runtime-test' }, { envelope, body })
    ).resolves.toMatchObject({ ok: true, value: { submission: { dispatchState: 'accepted' } } })
    expect(turn).toBe(1)
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
    await host.hold(SESSION, 'desktop-chat:requested-close')

    await stopStructuredAgentSessionRuntime()
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(connections).toHaveLength(1)
  })

  it('waits for an in-flight recovery before tearing down the runtime', async () => {
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
      resolveCodexCommand: () => 'codex',
      resolveEnvironment: async () => ({ PATH: process.env.PATH }),
      openCodexConnection: openConnection,
      readProcessStartTime: async () => 1_700_000_000_000
    })
    const attachParams = hostTestAttachParams(null, { providerHandle: undefined })
    attachParams.envelope.clientOperationId = operationId()
    const attached = await host.attach({ callerKey: 'runtime-test' }, attachParams)
    expect(attached.ok).toBe(true)
    await host.hold(SESSION, 'desktop-chat:shutdown-race')
    connections[0]?.handlers.onExit?.(new Error('recovery is still opening'))
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
})
