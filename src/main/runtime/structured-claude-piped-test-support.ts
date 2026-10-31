import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, vi, type Mock } from 'vitest'
import { createFakePipedChild } from '../../shared/__fixtures__/fake-spawned-child'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import { openClaudeStreamJsonConnection } from '../claude/claude-stream-json-connection'
import {
  hostTestAttachParams,
  hostTestMessage,
  HOST_TEST_SESSION as SESSION
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'

export { SESSION }
export async function claudePipedFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'orca-claude-kill-evidence-'))
  const children: ReturnType<typeof createFakePipedChild>[] = []
  const connections: Awaited<ReturnType<typeof openClaudeStreamJsonConnection>>[] = []
  const prompts: string[] = []
  const delivered = new Set<number>()
  const heldIdentity = new Map<number, Promise<void>>()
  const heldSpawn = new Map<number, Promise<void>>()
  const permitKill = new Set<number>()
  const omitInit = new Set<number>()
  const logs: Record<'warn' | 'error', Mock<(...args: unknown[]) => void>> = {
    warn: vi.fn(),
    error: vi.fn()
  }
  let operation = 0
  let processless = false
  const emit = (index: number, frame: unknown) =>
    children[index]!.stdout.write(`${JSON.stringify(frame)}\n`)
  const signal = vi.spyOn(process, 'kill').mockImplementation((pid, sig) => {
    const index = children.findIndex((child) => child.pid + 1 === -pid)
    if (index !== -1 && permitKill.has(index) && sig === 'SIGKILL') {
      if (!delivered.has(index)) {
        delivered.add(index)
        children[index]!.stdout.end()
        return true
      }
    }
    if (sig === 'SIGSTOP' || sig === 'SIGCONT') {
      return true
    }
    throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
  })
  const host = await ensureStructuredAgentSessionHost({
    stateDirectory: directory,
    hostId: 'local',
    claimKeyId: 'key-1',
    logger: logs,
    resolveWorkspacePath: async () => directory,
    resolveClaudeCommand: () => ({ command: '/fixture/claude', prefixArgs: [] }),
    resolveLaunchArgs: () => [],
    resolveClaudeAuthPolicy: () => ({ account: 'system' }),
    readProcessStartTime: async (pid) => {
      await heldIdentity.get(pid)
      return 1700000000000
    },
    openClaudeConnection: async (launch, handlers) => {
      const index = children.length
      const child = createFakePipedChild(9100000 + index * 100)
      Object.assign(child, { exitCode: null, signalCode: null, killed: false })
      children.push(child)
      let pending = ''
      child.stdin.on('data', (bytes) => {
        pending += String(bytes)
        for (;;) {
          const boundary = pending.indexOf('\n')
          if (boundary === -1) {
            break
          }
          const frame = JSON.parse(pending.slice(0, boundary))
          pending = pending.slice(boundary + 1)
          const sessionId = String(launch.options.sessionId ?? launch.options.resume)
          if (frame.type === 'control_request') {
            emit(index, {
              type: 'control_response',
              response: {
                subtype: 'success',
                request_id: frame.request_id,
                response:
                  frame.request.subtype === 'get_settings'
                    ? { model: 'claude-sonnet-5', permissionMode: 'default' }
                    : { commands: [], models: [], capabilities: ['msg_lifecycle_v1'] }
              }
            })
            if (frame.request.subtype === 'initialize' && !omitInit.has(index)) {
              emit(index, {
                type: 'system',
                subtype: 'init',
                session_id: sessionId,
                uuid: `init-${index}`,
                model: 'claude-sonnet-5'
              })
            }
          } else if (frame.type === 'user') {
            prompts.push(JSON.stringify(frame.message.content))
            emit(index, { ...frame, session_id: sessionId })
            emit(index, {
              type: 'assistant',
              session_id: sessionId,
              uuid: `reply-${index}`,
              parent_tool_use_id: null,
              message: {
                id: `reply-${index}`,
                role: 'assistant',
                type: 'message',
                model: 'claude-sonnet-5',
                content: [{ type: 'text', text: 'Healthy Claude reply' }],
                stop_reason: 'end_turn',
                stop_sequence: null,
                usage: { input_tokens: 1, output_tokens: 1 }
              }
            })
            emit(index, {
              type: 'result',
              subtype: 'success',
              session_id: sessionId,
              uuid: `result-${index}`,
              is_error: false,
              result: 'Healthy Claude reply',
              duration_ms: 1,
              duration_api_ms: 1,
              num_turns: 1,
              total_cost_usd: 0,
              usage: { input_tokens: 1, output_tokens: 1 },
              modelUsage: {},
              permission_denials: []
            })
          }
        }
      })
      child.kill.mockImplementation(() => false)
      const absent = processless
      processless = false
      if (absent) {
        Object.defineProperty(child, 'pid', { value: undefined })
      }
      const connection = await openClaudeStreamJsonConnection(launch, handlers, () => {
        if (absent) {
          queueMicrotask(() => {
            child.emit(
              'error',
              Object.assign(new Error('fixture executable absent'), { code: 'ENOENT' })
            )
            child.emit('close', -2, null)
            child.stdout.end()
          })
        }
        return child
      })
      connections.push(connection)
      await heldSpawn.get(index)
      return connection
    }
  })
  const caller = { callerKey: 'claude-kill-contract' }
  const record = () => host.deps.store.getRecord(SESSION)!
  const params = () => {
    const input = hostTestAttachParams(null, {
      provider: 'claude',
      agent: 'claude',
      providerHandle: undefined,
      accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: join(directory, 'claude-home') }
    })
    input.envelope.clientOperationId = `${Date.now()}-${(++operation).toString(16).padStart(32, '0')}`
    return input
  }
  const send = async (text: string) => {
    const body = hostTestMessage(text)
    return host.send(caller, {
      body,
      envelope: {
        sessionId: SESSION,
        clientOperationId: `${Date.now()}-${(++operation).toString(16).padStart(32, '0')}`,
        expectedRuntimeFence: record().lease.runtimeFence,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.send',
          sessionId: SESSION,
          fields: { body }
        })
      }
    })
  }
  return {
    host,
    children,
    connections,
    delivered,
    heldIdentity,
    heldSpawn,
    permitKill,
    logs,
    signal,
    directory,
    record,
    send,
    emit,
    caller,
    params,
    omitInit,
    adapter: host.deps.agents.registration('claude')!.adapter,
    observedExit: (index: number) => {
      children[index]!.emit('exit', 0, null)
      children[index]!.stdout.end()
      children[index]!.emit('close', 0, null)
    },
    nextProcessless: () => {
      processless = true
    },
    ready: async () =>
      vi.waitFor(() => expect(host.readStatusSummary(SESSION)?.hostExecutionPhase).toBe('ready')),
    healthy: async (text = 'A legitimate new message.') => {
      const before = prompts.length
      expect(await send(text)).toMatchObject({ ok: true })
      await vi.waitFor(() => expect(prompts.length).toBe(before + 1))
      await vi.waitFor(async () => {
        const journal = await host.journalSnapshot(SESSION)
        expect(journal.submissions.at(-1)?.dispatchState).toBe('accepted')
        expect(JSON.stringify(journal.items)).toContain('Healthy Claude reply')
      })
    },
    drain: () => host.collaboratorsForTests().serialize(SESSION, async () => {}),
    dispose: async () => {
      children.forEach((child) => {
        child.emit('exit', 0, null)
        child.stdout.end()
        child.emit('close', 0, null)
      })
      await stopStructuredAgentSessionRuntime()
      signal.mockRestore()
      await rm(directory, { recursive: true, force: true })
    }
  }
}
