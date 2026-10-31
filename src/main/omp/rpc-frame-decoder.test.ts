import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { JsonlRpcPeer } from '../jsonl-rpc/peer'
import { OmpRpcFrameDecoder, encodeOmpRpcFrame } from './rpc-frame-decoder'

describe('OMP RPC process stream', () => {
  it('sends large input as a single JSONL command because OMP only reassembles stdout', () => {
    const frame = { type: 'prompt', id: 'large', message: '目标🐋'.repeat(200_000) }
    const encoded = encodeOmpRpcFrame(frame)
    expect(encoded.split('\n')).toHaveLength(2)
    expect(JSON.parse(encoded)).toEqual(frame)
  })

  it('correlates a chunked UTF-8 response without exposing partial frames', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const decoder = new OmpRpcFrameDecoder()
    const peer = new JsonlRpcPeer(input, output, { decodeRecord: (frame) => decoder.decode(frame) })
    const reply = peer.request('get_entries')
    const body = Buffer.from(
      JSON.stringify({
        type: 'response',
        id: 'orca-1',
        command: 'get_entries',
        success: true,
        data: { text: '目标🐋' }
      })
    )
    const split = body.length - 3
    for (const [index, data] of [body.subarray(0, split), body.subarray(split)].entries()) {
      input.write(
        `${JSON.stringify({
          type: 'rpc_chunk',
          chunkId: 'large',
          index,
          count: 2,
          byteLength: body.length,
          data: data.toString('base64')
        })}\n`
      )
    }
    await expect(reply).resolves.toEqual({ text: '目标🐋' })
    peer.close()
  })
})
