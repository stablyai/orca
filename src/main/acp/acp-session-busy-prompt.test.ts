import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcpSessionRuntime } from './acp-session-runtime'
import { AcpConnectionClosedError } from './acp-errors'
import { AcpScriptedAgent, tick, type FakeFrame } from './acp-scripted-agent.test-support'

const opened: { runtime: AcpSessionRuntime; agent: AcpScriptedAgent }[] = []
const prompt = [{ type: 'text', text: 'keep this message' }] as const

async function fixture(retryBusyPrompts = true) {
  const agent = new AcpScriptedAgent()
  const runtime = new AcpSessionRuntime(agent.stdout, agent.stdin, { retryBusyPrompts })
  opened.push({ runtime, agent })
  agent.on('initialize', (frame) => agent.reply(frame, { protocolVersion: 1 }))
  agent.on('session/new', (frame) => agent.reply(frame, { sessionId: 'busy-session' }))
  await runtime.start({ cwd: '/workspace', mcpServers: [] })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const frames = () => agent.frames.filter((frame) => frame.method === 'session/prompt')
  const busy = (frame: FakeFrame) =>
    agent.fail(frame, -32003, 'Agent is already processing.', { reason: 'session_busy' })
  agent.on('session/prompt', busy)
  return { runtime, agent, frames, busy }
}

afterEach(() => {
  for (const { runtime, agent } of opened.splice(0)) {
    runtime.close()
    agent.close()
  }
  vi.useRealTimers()
})

describe('ACP busy prompt retries', () => {
  it('backs off, caps the delay, and retains every content block and metadata', async () => {
    const { runtime, agent, frames } = await fixture()
    const content = [...prompt, { type: 'image' as const, data: 'AA==', mimeType: 'image/png' }]
    const sent = runtime.prompt(content, { promptId: 'original' })
    await tick()
    for (const [delay, count] of [
      [1000, 2],
      [2000, 3],
      [4000, 4],
      [5000, 5],
      [5000, 6]
    ]) {
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(frames()).toHaveLength(count - 1)
      await vi.advanceTimersByTimeAsync(1)
      expect(frames()).toHaveLength(count)
    }
    agent.on('session/prompt', (frame) => agent.reply(frame, { stopReason: 'end_turn' }))
    await vi.advanceTimersByTimeAsync(5000)
    await expect(sent).resolves.toEqual({ stopReason: 'end_turn' })
    expect(new Set(frames().map((frame) => frame.id)).size).toBe(7)
    for (const frame of frames()) {
      expect(frame.params).toEqual({
        sessionId: 'busy-session',
        prompt: content,
        _meta: { promptId: 'original' }
      })
    }
    await vi.advanceTimersByTimeAsync(60_000)
    expect(frames()).toHaveLength(7)
  })

  it('allows only one logical prompt while waiting and accepts a later prompt after completion', async () => {
    const { runtime, agent, frames } = await fixture()
    const first = runtime.prompt([...prompt])
    await tick()
    await expect(runtime.prompt([{ type: 'text', text: 'overlap' }])).rejects.toThrow(
      'already in progress'
    )
    expect(frames()).toHaveLength(1)
    agent.on('session/prompt', (frame) => agent.reply(frame, { stopReason: 'end_turn' }))
    await vi.advanceTimersByTimeAsync(1000)
    await first
    await expect(runtime.prompt([{ type: 'text', text: 'next' }])).resolves.toEqual({
      stopReason: 'end_turn'
    })
    expect(frames()).toHaveLength(3)
  })

  it('Stop cancels a busy wait and never sends the rejected prompt again', async () => {
    const { runtime, agent, frames } = await fixture()
    const sent = runtime.prompt([...prompt])
    await tick()
    await runtime.cancel()
    await expect(sent).resolves.toEqual({ stopReason: 'cancelled' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(frames()).toHaveLength(1)
    expect(agent.frames.filter((frame) => frame.method === 'session/cancel')).toHaveLength(1)
    agent.on('session/prompt', (frame) => agent.reply(frame, { stopReason: 'end_turn' }))
    await expect(runtime.prompt([...prompt])).resolves.toEqual({ stopReason: 'end_turn' })
  })

  it('Stop during a wire attempt suppresses a busy response that arrives later', async () => {
    const { runtime, agent, frames, busy } = await fixture()
    const sent = runtime.prompt([...prompt])
    await tick()
    agent.on('session/prompt', () => {})
    await vi.advanceTimersByTimeAsync(1000)
    await runtime.cancel()
    busy(frames()[1]!)
    await expect(sent).resolves.toEqual({ stopReason: 'cancelled' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(frames()).toHaveLength(2)
  })

  it.each(['close', 'stream end'] as const)(
    'ends the retry on %s and preserves connection loss',
    async (how) => {
      const { runtime, agent, frames } = await fixture()
      const sent = runtime.prompt([...prompt])
      const rejected = expect(sent).rejects.toBeInstanceOf(AcpConnectionClosedError)
      await tick()
      if (how === 'close') {
        runtime.close(new AcpConnectionClosedError('closed during busy wait'))
      } else {
        agent.stdout.end()
      }
      await rejected
      await vi.advanceTimersByTimeAsync(60_000)
      expect(frames()).toHaveLength(1)
    }
  )

  it.each([
    [-32003, undefined, 'Agent is already processing.'],
    [-32003, { reason: 'something_else' }, 'Agent is already processing.'],
    [-32603, { reason: 'session_busy' }, 'Agent is already processing.'],
    [-32603, undefined, 'Internal error'],
    [-32000, { reason: 'session_busy' }, 'Sign in required']
  ] as const)('does not retry an unproven busy refusal (%s, %j)', async (code, data, message) => {
    const { runtime, agent, frames } = await fixture()
    agent.on('session/prompt', (frame) => agent.fail(frame, code, message, data))
    await expect(runtime.prompt([...prompt])).rejects.toMatchObject({ code, message })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(frames()).toHaveLength(1)
  })

  it('does not retry agents that did not opt in', async () => {
    const { runtime, frames } = await fixture(false)
    await expect(runtime.prompt([...prompt])).rejects.toMatchObject({ code: -32003 })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(frames()).toHaveLength(1)
  })

  it('surfaces a permanent rejection after busy without another attempt', async () => {
    const { runtime, agent, frames } = await fixture()
    const sent = runtime.prompt([...prompt])
    const rejected = expect(sent).rejects.toMatchObject({
      code: -32602,
      message: 'Unsupported input'
    })
    await tick()
    agent.on('session/prompt', (frame) => agent.fail(frame, -32602, 'Unsupported input'))
    await vi.advanceTimersByTimeAsync(1000)
    await rejected
    await vi.advanceTimersByTimeAsync(60_000)
    expect(frames()).toHaveLength(2)
  })

  it('does not retry an unreadable reply or a successful empty turn', async () => {
    const { runtime, agent, frames } = await fixture()
    agent.on('session/prompt', (frame) => agent.reply(frame, 'bad response'))
    await expect(runtime.prompt([...prompt])).rejects.toThrow('Invalid ACP response')
    agent.on('session/prompt', (frame) => agent.reply(frame, { stopReason: 'end_turn' }))
    await expect(runtime.prompt([...prompt])).resolves.toEqual({ stopReason: 'end_turn' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(frames()).toHaveLength(2)
  })
})
