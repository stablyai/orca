import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { RelayedProviderOutput } from '../../../provider-relay/relayed-provider-output'
import { AcpRelayTurns } from '../acp-relay-ack-floor'

const update = (sessionUpdate: string, rest: Record<string, unknown> = {}): string =>
  JSON.stringify({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId: 's', update: { sessionUpdate, ...rest } }
  })
const chunk = (text: string, messageId?: string): string =>
  update('agent_message_chunk', {
    content: { type: 'text', text },
    ...(messageId ? { messageId } : {})
  })

function rig() {
  const acks: number[] = []
  const turns = new AcpRelayTurns()
  const output = new RelayedProviderOutput({
    stdout: new Readable({ read() {} }),
    ackFloor: turns.ackFloor(),
    durable: async () => true,
    // Where a reattach would replay from, less one: the daemon keeps lines from `keepFrom` on, and
    // never gets back lines it already dropped.
    ack: async (seq, keepFrom) => {
      const replayedFrom = (keepFrom ?? seq + 1) - 1
      if (replayedFrom > (acks.at(-1) ?? 0)) {
        acks.push(replayedFrom)
      }
    }
  })
  output.restartAt(0)
  let seq = 0
  const send = async (...lines: string[]): Promise<number[]> => {
    lines.forEach((line) => output.line('relayData', ++seq, line))
    await output.settle()
    return acks
  }
  /** A prompt the app sends; resolve or reject it to answer. */
  const prompt = () => {
    let settle!: { resolve: () => void; reject: (error: Error) => void }
    const answered = turns.track(
      () =>
        new Promise<void>((resolve, reject) => {
          settle = { resolve, reject }
        })
    )
    answered.catch(() => {})
    return settle
  }
  /** The connection's parse of a line it was handed. */
  const parsed = (line: string) => turns.observeSessionUpdate(JSON.parse(line).params)
  return { output, acks, send, prompt, parsed }
}

describe('ACP relay ack floor', () => {
  it('acks only below the start of an open call or message, so a replay rewrites each whole', async () => {
    const { send, prompt, parsed } = rig()
    const answer = prompt()
    // A chunk with an id shows the agent numbers no messages, so only open items hold.
    await send(chunk('a', 'm1'))
    expect(await send(chunk('b', 'm1'))).toEqual([])
    // A call ends the message; the call holds until the connection reads its final status.
    await send(
      update('tool_call', {
        toolCallId: 'c1',
        status: 'in_progress',
        rawOutput: { status: 'completed' }
      })
    )
    expect(await send(update('tool_call_update', { toolCallId: 'c1', content: [] }))).toEqual([2])
    const done = update('tool_call_update', { toolCallId: 'c1', status: 'completed' })
    await send(done)
    parsed(done)
    expect(await send()).toEqual([2, 5])
    // An open message holds until its prompt's answer.
    expect(await send(chunk('c', 'm2'))).toEqual([2, 5])
    answer.resolve()
    await vi.waitFor(async () =>
      expect(await send(update('plan', { entries: [] }))).toEqual([2, 5, 7])
    )
  })

  it("holds an unnumbered agent's prompt from its first line until it ends, even by failing", async () => {
    const { output, acks, send, prompt, parsed } = rig()
    // A turn the agent began itself holds nothing: it replays as a turn of its own.
    expect(await send(chunk('idle'))).toEqual([1])
    const answer = prompt()
    await send(update('tool_call', { toolCallId: 'c1' }))
    const failed = update('tool_call_update', { toolCallId: 'c1', status: 'failed' })
    await send(failed)
    parsed(failed)
    // Without ids its messages are numbered from the turn's start, so nothing in the turn is acked.
    expect(await send(chunk('a'), chunk('b'))).toEqual([1])
    // The daemon's ask (its file cap) passes the floor; what it released is never kept again, so
    // a later restart replays only the rest, renumbered, and duplicates nothing.
    await output.settle(true)
    expect(acks).toEqual([1, 5])
    expect(await send(chunk('c'))).toEqual([1, 5, 6])
    answer.reject(new Error('rate limited'))
    await vi.waitFor(async () => expect(await send(chunk('later'))).toEqual([1, 5, 6, 7]))
  })

  it('reads a long update from its ends without parsing its payload', async () => {
    const { send, prompt } = rig()
    prompt()
    const parse = vi.spyOn(JSON, 'parse')
    const big = 'x'.repeat(64 * 1024)
    await send(update('tool_call', { toolCallId: 'c1', status: 'in_progress' }))
    await send(
      update('tool_call_update', { toolCallId: 'c1', content: [{ type: 'text', text: big }] })
    )
    await send(chunk(big, 'm1'))
    const end = { toolCallId: 'c1', status: 'completed', content: [{ type: 'text', text: big }] }
    await send(update('tool_call_update', end))
    // Envelope fields are read with small parses; no whole line is parsed, even a call's end.
    expect(parse.mock.calls.filter(([text]) => text.length > 1024)).toEqual([])
    parse.mockRestore()
  })
})
