import { describe, expect, it } from 'vitest'
import { OmpRpcChunkReassembler } from './omp-rpc-chunk-reassembler'

const limits = { maxFrameBytes: 4, maxReassembledFrameBytes: 64 }

describe('OmpRpcChunkReassembler', () => {
  it('rejects an empty chunk before retaining it', () => {
    const reassembler = new OmpRpcChunkReassembler(limits)
    expect(
      reassembler.accept({
        type: 'rpc_chunk',
        chunkId: 'frame-1',
        index: 0,
        count: 2,
        byteLength: 4,
        data: ''
      })
    ).toMatchObject({ kind: 'fault', message: expect.stringContaining('empty') })
    expect(reassembler.hasPending).toBe(false)
  })

  it('rejects an impractically large chunk count before allocating a sequence', () => {
    const reassembler = new OmpRpcChunkReassembler(limits)
    expect(
      reassembler.accept({
        type: 'rpc_chunk',
        chunkId: 'frame-1',
        index: 0,
        count: Number.MAX_SAFE_INTEGER,
        byteLength: 64,
        data: 'YQ=='
      })
    ).toMatchObject({ kind: 'fault', message: expect.stringContaining('count') })
    expect(reassembler.hasPending).toBe(false)
  })
})
