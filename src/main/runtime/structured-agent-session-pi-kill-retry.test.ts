import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createFakePipedChild } from '../../shared/__fixtures__/fake-spawned-child'
import { observeStructuredSession } from './structured-worker-authority'
import { JsonlRpcAgentConnection } from '../jsonl-rpc/agent-connection'
import {
  hostTestAttachParams,
  hostTestMessage,
  HOST_TEST_SESSION as SESSION
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import { PROVIDER_SUPERVISOR_MAX_STOP_MS } from '../provider-process/provider-process-supervisor'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'

const os = vi.hoisted(() => ({
  capture: vi.fn(),
  terminate: vi.fn(async () => 'unverifiable' as const)
}))
vi.mock('../pty-descendant-termination', () => ({ captureDescendantSnapshot: os.capture }))
vi.mock('../pty-descendant-exit-verification', () => ({
  terminateDescendantSnapshotWithVerdict: os.terminate
}))
vi.mock('../crash-reporting/self-initiated-tree-kill-log', () => ({
  recordSelfInitiatedTreeKill: vi.fn()
}))

let directory: string | undefined
const children: ReturnType<typeof createFakePipedChild>[] = []
afterEach(async () => {
  children.forEach((child) => child.emit('exit', 0, null))
  await stopStructuredAgentSessionRuntime()
  children.length = 0
  vi.useRealTimers()
  vi.restoreAllMocks()
  if (directory) {
    await rm(directory, { recursive: true, force: true })
  }
})

it('settles a production failed Pi start after background kill, then delivers on the next user wake', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  directory = await mkdtemp(join(tmpdir(), 'orca-pi-kill-retry-'))
  const permitIdentity = Promise.withResolvers<void>()
  const connections: JsonlRpcAgentConnection[] = []
  const prompts: string[] = []
  let delivered = false
  const signal = vi.spyOn(process, 'kill').mockImplementation((pid) => {
    if (pid === -9000201 && !delivered) {
      delivered = true
      return true
    }
    throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
  })
  os.capture.mockImplementation(async (pid: number) => ({
    rootPgid: pid,
    capturedAtMs: 1,
    root: { pid, startedAt: 'Mon Jan 1 00:00:00 2026' },
    descendants: [{ pid: pid + 1, ppid: pid, pgid: pid + 1, startedAt: 'Mon Jan 1 00:00:00 2026' }]
  }))
  const host = await ensureStructuredAgentSessionHost({
    stateDirectory: directory,
    hostId: 'local',
    claimKeyId: 'key-1',
    logger: { warn: vi.fn(), error: vi.fn() },
    resolveWorkspacePath: async () => directory!,
    resolveClaudeAuthPolicy: () => ({ account: 'managed' }),
    resolveLaunchArgs: () => [],
    resolvePiLaunch: async ({ identity }) => ({
      command: '/fixture/pi',
      cwd: directory!,
      fullAccess: true,
      previous: null,
      ...(identity.providerHandle ? { sessionFile: identity.providerHandle.nativeId } : {})
    }),
    readProcessStartTime: async (pid) => {
      if (pid === 9000200) {
        await permitIdentity.promise
      }
      return 1700000000000
    },
    openPiConnection: (launch, handlers) => {
      const child = createFakePipedChild(9000100 + children.length * 100)
      children.push(child)
      if (child.pid !== 9000200) {
        child.stdin.once('finish', () => child.emit('exit', 0, null))
        child.stdin.on('data', (bytes) => {
          const frame = JSON.parse(String(bytes))
          const emit = (value: unknown) => child.stdout.write(`${JSON.stringify(value)}\n`)
          if (frame.type === 'prompt') {
            prompts.push(frame.message)
            emit({ type: 'agent_start' })
            emit({ type: 'message_end', message: { role: 'user', content: frame.message } })
            emit({
              type: 'response',
              command: 'prompt',
              success: true,
              data: { disposition: 'started' }
            })
            emit({
              type: 'message_end',
              message: { role: 'assistant', content: 'Healthy Pi reply', stopReason: 'stop' }
            })
            emit({ type: 'agent_end' })
            emit({ type: 'agent_settled' })
          } else {
            const data =
              frame.type === 'get_state'
                ? {
                    sessionFile: join(directory!, 'session.jsonl'),
                    model: { provider: 'openai', id: 'gpt-5.4' },
                    thinkingLevel: 'medium',
                    isStreaming: false,
                    isCompacting: false,
                    pendingMessageCount: 0
                  }
                : frame.type === 'get_available_models'
                  ? { models: [{ provider: 'openai', id: 'gpt-5.4' }] }
                  : frame.type === 'get_entries'
                    ? { entries: [], leafId: null }
                    : { commands: [] }
            emit({ type: 'response', id: frame.id, command: frame.type, success: true, data })
          }
        })
      }
      const connection = new JsonlRpcAgentConnection(launch, handlers, () => child)
      connections.push(connection)
      return connection
    }
  })
  const caller = { callerKey: 'pi-retry-test' }
  const attach = hostTestAttachParams(null, {
    provider: 'pi',
    agent: 'pi',
    providerHandle: undefined,
    accountHome: { variable: 'PI_CODING_AGENT_DIR', path: join(directory, 'pi-home') }
  })
  attach.envelope.clientOperationId = `${Date.now()}-${'a'.repeat(32)}`
  expect(await host.attach(caller, attach)).toMatchObject({ ok: true })
  await vi.waitFor(() =>
    expect(host.collaboratorsForTests().sessions.get(SESSION)?.child?.phase).toBe('ready')
  )
  await host.close(SESSION, 'evict')
  let operation = 0
  const send = async (text: string) => {
    const body = hostTestMessage(text)
    const fence = host['deps'].store.getRecord(SESSION)!.lease.runtimeFence
    return host.send(caller, {
      body,
      envelope: {
        sessionId: SESSION,
        clientOperationId: `${Date.now()}-${(++operation).toString(16).padStart(32, '0')}`,
        expectedRuntimeFence: fence,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.send',
          sessionId: SESSION,
          fields: { body }
        })
      }
    })
  }
  const pending = await send('First start fails before open.')
  expect(pending.ok).toBe(true)
  await vi.waitFor(() => expect(connections).toHaveLength(2))
  children[1]!.emit('error', new Error('RPC startup transport failed'))
  await vi.advanceTimersByTimeAsync(PROVIDER_SUPERVISOR_MAX_STOP_MS + 1000)
  expect(connections[1]!.lastCloseResult).toMatchObject({ root: 'live', killDelivered: true })
  permitIdentity.resolve()
  await vi.waitFor(() =>
    expect(host['deps'].store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'released',
      ownerProcess: null,
      deathEvidence: { kind: 'kill-delivered' }
    })
  )
  expect(observeStructuredSession(SESSION)).toEqual({ status: 'exited' })
  await host.collaboratorsForTests().serialize(SESSION, async () => {})
  const failed = await host.journalSnapshot(SESSION)
  if (!pending.ok) {
    throw new Error('send refused')
  }
  expect(
    failed.submissions.find((row) => row.clientMessageId === pending.value.clientMessageId)
      ?.dispatchState
  ).toBe('rejected')
  expect(
    host['deps'].store.listOperationRows().some((row) => row.outcome.status === 'pending')
  ).toBe(false)
  expect(signal.mock.calls.filter(([pid]) => pid === -9000201)).toHaveLength(1)
  expect(await send('A legitimate new user message.')).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(prompts).toEqual(['A legitimate new user message.']))
  await vi.waitFor(async () => {
    const snapshot = await host.journalSnapshot(SESSION)
    expect(snapshot.submissions.at(-1)?.dispatchState).toBe('accepted')
    expect(JSON.stringify(snapshot.items)).toContain('Healthy Pi reply')
  })
  expect(connections).toHaveLength(3)
  expect(observeStructuredSession(SESSION)).toEqual({ status: 'live' })
})
