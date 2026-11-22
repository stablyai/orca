import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcpConnectionClosedError } from '../transport/acp-errors'
import { AcpSessionRuntime } from './acp-session-runtime'
import type { AcpSessionRuntimeOptions } from './acp-session-runtime-options'
import {
  AcpScriptedAgent,
  deferred,
  tick
} from '../process/testing/acp-scripted-agent.test-support'
import type { AgentCapabilities } from '../generated/acp-protocol.generated'

const opened: { runtime: AcpSessionRuntime; agent: AcpScriptedAgent }[] = []
const startOptions = { cwd: '/runtime/project', mcpServers: [] }
const textPrompt = [{ type: 'text', text: 'hello' }] as const
const permission = {
  sessionId: 'session-1',
  toolCall: { toolCallId: 'tool-1', title: 'Edit file' },
  options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }]
}
function fixture(capabilities: AgentCapabilities = {}, options: AcpSessionRuntimeOptions = {}) {
  const agent = new AcpScriptedAgent()
  agent.on('initialize', (frame) =>
    agent.reply(frame, { protocolVersion: 1, agentCapabilities: capabilities })
  )
  agent.on('session/new', (frame) => agent.reply(frame, { sessionId: 'session-1' }))
  agent.on('session/load', (frame) => agent.reply(frame, {}))
  agent.on('session/resume', (frame) => agent.reply(frame, {}))
  agent.on('session/prompt', (frame) => agent.reply(frame, { stopReason: 'end_turn' }))
  const runtime = new AcpSessionRuntime(agent.stdout, agent.stdin, options)
  opened.push({ runtime, agent })
  return { runtime, agent }
}
afterEach(() => {
  for (const { runtime, agent } of opened.splice(0)) {
    runtime.close()
    agent.close()
  }
  vi.useRealTimers()
})

describe('ACP session runtime', () => {
  it('lets the agent ask from its own turn while a busy refusal holds the prompt', async () => {
    const asked: string[] = []
    const { runtime, agent } = fixture(
      {},
      {
        retryBusyPrompts: true,
        onPermission: (request) => {
          asked.push(request.toolCall.toolCallId)
          return { outcome: { outcome: 'selected', optionId: 'allow' } }
        }
      }
    )
    await runtime.start(startOptions)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    agent.on('session/prompt', (frame) => {
      const refusal = {
        jsonrpc: '2.0',
        id: frame.id,
        error: { code: -32003, message: 'busy', data: { reason: 'session_busy' } }
      }
      const autonomous = {
        jsonrpc: '2.0',
        id: 'same-chunk',
        method: 'session/request_permission',
        params: permission
      }
      agent.stdout.write(`${JSON.stringify(refusal)}\n${JSON.stringify(autonomous)}\n`)
    })
    const pending = runtime.prompt([...textPrompt])
    await tick()
    expect(agent.frames.find((frame) => frame.id === 'same-chunk')).toMatchObject({
      result: { outcome: { outcome: 'selected', optionId: 'allow' } }
    })
    agent.on('session/prompt', (frame) => {
      void agent.request('admitted', 'session/request_permission', permission).then(() => {
        agent.reply(frame, { stopReason: 'end_turn' })
      })
    })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await pending).toEqual({ stopReason: 'end_turn' })
    expect(asked).toHaveLength(2)
  })

  it('refuses unsupported restoration without silently creating a different session', async () => {
    const { runtime, agent } = fixture({ sessionCapabilities: { resume: null } })
    await expect(runtime.start({ ...startOptions, sessionId: 'old' })).rejects.toMatchObject({
      code: -32601
    })
    expect(agent.frames.map((frame) => frame.method)).toEqual(['initialize'])
  })

  it('rejects unroutable permission requests and answers an unavailable selection cancelled', async () => {
    const diagnostics: string[] = []
    const { runtime, agent } = fixture(
      {},
      {
        onPermission: () => ({ outcome: { outcome: 'selected', optionId: 'not-offered' } }),
        onDiagnostic: (message) => diagnostics.push(message)
      }
    )
    agent.on('session/prompt', () => {})
    await runtime.start(startOptions)
    void runtime.prompt([...textPrompt]).catch(() => {})
    expect(await agent.request('invalid', 'session/request_permission', {})).toMatchObject({
      error: { code: -32602 }
    })
    expect(
      await agent.request('no-options', 'session/request_permission', {
        ...permission,
        options: [{ name: 'No id', kind: 'allow_once' }]
      })
    ).toMatchObject({ error: { code: -32602 } })
    expect(
      await agent.request('bad-selection', 'session/request_permission', permission)
    ).toMatchObject({ result: { outcome: { outcome: 'cancelled' } } })
    expect(diagnostics).toContain(
      'Answered ACP permission request cancelled: handler selected an unavailable option'
    )
    // A local permission failure must leave the session usable.
    await expect(runtime.prompt([...textPrompt])).rejects.toThrow('already in progress')
  })

  it('rejects pending calls and aborts permission hooks when protocol input ends', async () => {
    const requested = deferred<AbortSignal>()
    const { runtime, agent } = fixture(
      {},
      {
        onPermission: (_request, context) => {
          requested.resolve(context.signal)
          return new Promise(() => {})
        }
      }
    )
    agent.on('session/prompt', () => {
      void agent.request('permission', 'session/request_permission', permission)
    })
    await runtime.start(startOptions)
    const pending = runtime.prompt([...textPrompt])
    const rejected = expect(pending).rejects.toBeInstanceOf(AcpConnectionClosedError)
    const signal = await requested.promise
    agent.stdout.end()
    await rejected
    expect(signal.aborted).toBe(true)
    await expect(runtime.setMode('plan')).rejects.toBeInstanceOf(AcpConnectionClosedError)
  })
})
