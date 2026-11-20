import { PassThrough, Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JsonlRpcPeer, type JsonlRpcPeerHandlers } from './peer'
import type { JsonlRpcPeerOptions } from './peer-limits'

const peers: JsonlRpcPeer[] = []
function fixture(
  handlers: JsonlRpcPeerHandlers = {},
  options: JsonlRpcPeerOptions = {},
  output = new PassThrough()
) {
  const input = new PassThrough()
  const peer = new JsonlRpcPeer(input, output, handlers, options)
  peers.push(peer)
  const reply = (record: unknown): void => {
    input.write(`${JSON.stringify(record)}\n`)
  }
  return { input, output, peer, reply }
}
afterEach(() => {
  for (const peer of peers.splice(0)) {
    peer.close()
  }
  vi.useRealTimers()
})

describe('JSON-lines RPC peer', () => {
  it('keeps required replies and queued events around an oversized paused optional suffix', async () => {
    const records: unknown[] = []
    const { peer, input } = fixture(
      {
        onRecord: (record) => {
          records.push(record)
          if (record.type === 'first' || record.type === 'second') {
            peer.pauseReading()
          }
        }
      },
      { maxLineBytes: 256 }
    )
    const optional = expect(
      peer.request('get_entries', {}, { oversizedReply: 'reject' })
    ).rejects.toThrow('exceeded 256 bytes')
    const state = peer.request('get_state')
    // Already-read bytes can arrive within a burst after the consumer pauses.
    input.emit(
      'data',
      '{"type":"first"}\n{"type":"second"}\n{"id":"orca-1","type":"response","command":"get_state","success":true,"data":{}}\n{"id":"orca-optional-1","type":"response","data":"'
    )
    input.emit('data', 'x'.repeat(70_000))
    await optional
    peer.resumeReading()
    expect(records).toEqual([{ type: 'first' }, { type: 'second' }])
    peer.resumeReading()
    await expect(state).resolves.toEqual({})
    input.emit('data', 'remaining optional bytes\n')
    input.emit('data', '{"type":"agent_settled"}\n')
    expect(records).toEqual([{ type: 'first' }, { type: 'second' }, { type: 'agent_settled' }])
    expect(peer.closed).toBe(false)
  })

  it('closes a stalled active control write on timeout so later aborts cannot wait on it', async () => {
    vi.useFakeTimers()
    const output = new Writable({ write() {} })
    const peer = new JsonlRpcPeer(new PassThrough(), output, {}, { requestTimeoutMs: 10 })
    peers.push(peer)
    const pending = expect(peer.request('get_state')).rejects.toThrow('in time')
    await vi.advanceTimersByTimeAsync(10)
    await pending
    expect(peer.closed).toBe(true)
    await expect(peer.send({ type: 'abort' })).rejects.toThrow('in time')
  })
})
