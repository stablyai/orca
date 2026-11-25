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

function rig(durable: (force: boolean) => Promise<boolean> = async () => true) {
  const acks: number[] = []
  const cuts: number[] = []
  const cutKeys: unknown[] = []
  const turns = new AcpRelayTurns()
  const output = new RelayedProviderOutput({
    stdout: new Readable({ read() {} }),
    ackFloor: turns.ackFloor(),
    durable,
    // Where a reattach would replay from, less one: the daemon keeps lines from `keepFrom` on, and
    // never gets back lines it already dropped.
    ack: async (seq, keepFrom, flags) => {
      if (flags?.cut) {
        cuts.push(seq)
        cutKeys.push(flags.cutKeys)
      }
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
  return { output, acks, cuts, cutKeys, send, prompt, parsed }
}

describe('ACP relay ack floor', () => {
  it('acks only below the start of an open call or message, so a replay rewrites each whole', async () => {
    const { send, prompt, parsed } = rig()
    const answer = prompt()
    // A chunk with an id shows the agent numbers no messages, so only open items hold.
    await send(chunk('a', 'm1'))
    expect(await send(chunk('b', 'm1'))).toEqual([])
    // A message goes on past a call under its id (OpenCode's step), so it still holds.
    await send(
      update('tool_call', {
        toolCallId: 'c1',
        status: 'in_progress',
        rawOutput: { status: 'completed' }
      })
    )
    await send(chunk('b2', 'm1'))
    const done = update('tool_call_update', { toolCallId: 'c1', status: 'completed' })
    await send(done)
    parsed(done)
    expect(await send()).toEqual([])
    // Another message ends it; that one holds until its prompt's answer.
    expect(await send(chunk('c', 'm2'))).toEqual([5])
    answer.resolve()
    await vi.waitFor(async () =>
      expect(await send(update('plan', { entries: [] }))).toEqual([5, 7])
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
    // A call that starts after the release still holds from its start: the release lets go of the
    // turn's start, so it no longer masks the call's.
    await send(update('tool_call', { toolCallId: 'c2' }))
    expect(await send(chunk('d'))).toEqual([1, 5, 6])
    answer.reject(new Error('rate limited'))
    await vi.waitFor(async () => expect(await send(chunk('later'))).toEqual([1, 5, 6, 9]))
  })

  it('cuts every ack while a message a forced ack released still streams, so its tail continues apart', async () => {
    const { output, cuts, cutKeys, send, prompt } = rig()
    prompt()
    await send(chunk('a', 'm1'), chunk('b', 'm1'))
    await output.settle(true)
    await send(chunk('c', 'm1'))
    expect(cuts).toEqual([2, 3])
    // Each cut names the message it splits, so a reattach moves exactly that one.
    expect(cutKeys[0]).toEqual([JSON.stringify(['s', 'm1'])])
    // A plan or call doesn't end it (it may resume under its id); the next message does.
    await send(update('plan', { entries: [] }))
    await send(chunk('c2', 'm1'))
    await send(chunk('d', 'm2'))
    expect(cuts).toEqual([2, 3, 4, 5])
  })

  it('acks every line handed on at a hand-off, saving streamed text first', async () => {
    // Streamed text is saved only on a forced flush; a plain settle can't ack past it.
    const { output, acks, send } = rig(async (force) => force)
    await send(chunk('a'), chunk('b'))
    expect(acks).toEqual([])
    await output.flush()
    expect(acks).toEqual([2])
  })

  it("holds an OpenCode child's open message until its session reports a status", async () => {
    const { send } = rig()
    const child = (params: Record<string, unknown>): string =>
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'opencode/session/child_update',
        params: { rootSessionId: 's', childSessionId: 'c', ...params }
      })
    const text = { type: 'text', text: 'x' }
    const update = { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: text }
    await send(child({ type: 'update', update }))
    expect(await send(child({ type: 'update', update }))).toEqual([])
    expect(await send(child({ type: 'status', status: 'completed' }))).toEqual([3])
  })

  it("keeps a subagent's message held past its parent prompt's answer", async () => {
    const { send, prompt } = rig()
    const answer = prompt()
    const child = (params: Record<string, unknown>): string =>
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'opencode/session/child_update',
        params: { rootSessionId: 's', childSessionId: 'c', ...params }
      })
    const text = { type: 'text', text: 'x' }
    const update = { sessionUpdate: 'agent_message_chunk', messageId: 'k1', content: text }
    await send(chunk('a', 'm1'), child({ type: 'update', update }))
    answer.resolve()
    // The root's turn ended, so its message goes; the child's still streams and still holds.
    await vi.waitFor(async () => expect(await send(child({ type: 'update', update }))).toEqual([1]))
    expect(await send(child({ type: 'status', status: 'completed' }))).toEqual([1, 4])
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
