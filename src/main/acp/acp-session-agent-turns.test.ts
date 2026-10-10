import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { AcpAgentError, AcpInvalidResponseError } from './acp-errors'
import { AcpSessionRuntime, type AcpSessionRuntimeOptions } from './acp-session-runtime'
import { AcpScriptedAgent, type FakeFrame, tick } from './acp-scripted-agent.test-support'

const opened: { close: () => void }[] = []
const startOptions = { cwd: '/runtime/project', mcpServers: [] }
const prompt = [{ type: 'text', text: 'hello' }] as const
function fixture(options: AcpSessionRuntimeOptions = {}) {
  const agent = new AcpScriptedAgent()
  const runtime = new AcpSessionRuntime(agent.stdout, agent.stdin, options)
  opened.push(agent, runtime)
  agent.on('initialize', (frame) => agent.reply(frame, { protocolVersion: 1 }))
  agent.on('session/new', (frame) => agent.reply(frame, { sessionId: 'session-1' }))
  return { agent, runtime }
}
afterEach(() =>
  opened
    .splice(0)
    .toReversed()
    .forEach((resource) => resource.close())
)

describe('ACP turns the agent begins and the runtime contract around them', () => {
  it('delivers extension notifications in arrival order with session updates', async () => {
    const order: string[] = []
    const { agent, runtime } = fixture({
      onExtensionNotification: (method, params) => order.push(`${method} ${JSON.stringify(params)}`)
    })
    runtime.subscribe((event) => order.push(`update ${event.kind}`))
    await runtime.start(startOptions)
    const completed = { sessionId: 'session-1', update: { type: 'turn_completed', prompt_id: 'p' } }
    agent.stdout.write(
      [
        { jsonrpc: '2.0', method: '_x.ai/session_notification', params: { started: true } },
        {
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'session-1',
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } }
          }
        },
        { jsonrpc: '2.0', method: '_x.ai/session_notification', params: completed }
      ]
        .map((frame) => `${JSON.stringify(frame)}\n`)
        .join('')
    )
    await tick()
    expect(order).toEqual([
      '_x.ai/session_notification {"started":true}',
      'update known',
      `_x.ai/session_notification ${JSON.stringify(completed)}`
    ])
  })

  it('sends session/cancel with no prompt of Orca running, and _meta on every session call', async () => {
    const { agent, runtime } = fixture()
    agent.on('session/prompt', (frame) => agent.reply(frame, { stopReason: 'end_turn' }))
    agent.on('session/set_mode', (frame) => agent.reply(frame, {}))
    agent.on('session/set_model', (frame) => agent.reply(frame, {}))
    agent.on('session/set_config_option', (frame) => agent.reply(frame, { configOptions: [] }))
    await runtime.start(startOptions)
    const meta = { traceId: 't' }
    await runtime.prompt([...prompt], meta)
    await runtime.setMode('plan', meta)
    await runtime.setModel('model-1', meta)
    await runtime.setConfigOption('effort', 'high', meta)
    await runtime.cancel({ meta })
    await tick()
    const sent = agent.frames.filter((frame) => frame.method?.startsWith('session/'))
    expect(sent.map((frame) => frame.method)).toEqual([
      'session/new',
      'session/prompt',
      'session/set_mode',
      'session/set_model',
      'session/set_config_option',
      'session/cancel'
    ])
    for (const frame of sent.slice(1)) {
      expect(frame.params).toMatchObject({ sessionId: 'session-1', _meta: meta })
    }
  })

  it("separates the agent's own errors from answers Orca could not read", async () => {
    const { agent, runtime } = fixture()
    await runtime.start(startOptions)
    agent.on('session/set_mode', (frame) => agent.fail(frame, -32603, 'Agent broke', { why: 1 }))
    const refused = await runtime.setMode('plan').catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(AcpAgentError)
    expect(refused).toMatchObject({ code: -32603, data: { why: 1 } })
    agent.on('session/set_mode', (frame) => agent.reply(frame, 'not-an-object'))
    const unreadable = await runtime.setMode('plan').catch((error: unknown) => error)
    expect(unreadable).toBeInstanceOf(AcpInvalidResponseError)
    expect(unreadable).not.toBeInstanceOf(AcpAgentError)
    expect(unreadable).toMatchObject({ code: -32603, data: 'not-an-object' })
    expect(unreadable instanceof AcpInvalidResponseError && unreadable.issues).toBeTruthy()
  })

  it('completes a turn whose stop reason is newer than this schema', async () => {
    const { agent, runtime } = fixture()
    agent.on('session/prompt', (frame) => agent.reply(frame, { stopReason: 'context_exhausted' }))
    await runtime.start(startOptions)
    expect(await runtime.prompt([...prompt])).toEqual({ stopReason: 'context_exhausted' })
  })

  it('retries a cancel whose write failed instead of returning the stale failure', async () => {
    const agent = new AcpScriptedAgent()
    const stdin = new PassThrough({ highWaterMark: 1 })
    const runtime = new AcpSessionRuntime(agent.stdout, stdin, {
      peer: { maxQueuedWriteBytes: 1000 }
    })
    opened.push(agent, runtime)
    const frames: FakeFrame[] = []
    let promptFrame: FakeFrame | undefined
    let buffer = ''
    stdin.setEncoding('utf8').on('data', (chunk: string) => {
      buffer += chunk
      let newline: number
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const frame: FakeFrame = JSON.parse(buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
        frames.push(frame)
        if (frame.method === 'initialize') {
          agent.reply(frame, { protocolVersion: 1 })
        } else if (frame.method === 'session/new') {
          agent.reply(frame, { sessionId: 'session-1' })
        } else if (frame.method === 'session/prompt') {
          promptFrame = frame
          stdin.pause()
        } else if (frame.method === 'session/cancel' && promptFrame) {
          agent.reply(promptFrame, { stopReason: 'cancelled' })
        }
      }
    })
    await runtime.start(startOptions)
    const turn = runtime.prompt([...prompt])
    await tick()
    void runtime.setMode('y'.repeat(850)).catch(() => {})
    await expect(runtime.cancel()).rejects.toThrow(/capacity/)
    stdin.resume()
    await tick()
    await runtime.cancel()
    expect(await turn).toEqual({ stopReason: 'cancelled' })
    expect(frames.filter((frame) => frame.method === 'session/cancel')).toHaveLength(1)
  })
})
