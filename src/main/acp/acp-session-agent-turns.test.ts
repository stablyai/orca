import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'

import { AcpSessionRuntime } from './acp-session-runtime'
import { AcpScriptedAgent, type FakeFrame, tick } from './acp-scripted-agent.test-support'

const opened: { close: () => void }[] = []
const startOptions = { cwd: '/runtime/project', mcpServers: [] }
const prompt = [{ type: 'text', text: 'hello' }] as const

afterEach(() =>
  opened
    .splice(0)
    .toReversed()
    .forEach((resource) => resource.close())
)

describe('ACP turns the agent begins and the runtime contract around them', () => {
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
