import { z } from 'zod'

const chunkSchema = z.object({
  type: z.literal('rpc_chunk'),
  chunkId: z.string().min(1).max(256),
  index: z.number().int().nonnegative(),
  count: z.number().int().positive().max(4096),
  byteLength: z
    .number()
    .int()
    .positive()
    .max(64 * 1024 * 1024),
  data: z.string().max(1024 * 1024)
})

export class OmpRpcFrameDecoder {
  private pending?: {
    id: string
    count: number
    length: number
    next: number
    bytes: number
    parts: Buffer[]
  }

  decode(frame: unknown): unknown[] {
    if (!z.object({ type: z.literal('rpc_chunk') }).safeParse(frame).success) {
      if (this.pending) {
        throw new Error('OMP interrupted a chunked RPC frame')
      }
      return [frame]
    }
    const chunk = chunkSchema.parse(frame)
    if (!this.pending && chunk.index === 0) {
      this.pending = {
        id: chunk.chunkId,
        count: chunk.count,
        length: chunk.byteLength,
        next: 0,
        bytes: 0,
        parts: []
      }
    }
    const pending = this.pending
    if (
      !pending ||
      chunk.chunkId !== pending.id ||
      chunk.index !== pending.next ||
      chunk.count !== pending.count ||
      chunk.byteLength !== pending.length
    ) {
      throw new Error('OMP RPC chunk sequence is invalid')
    }
    const bytes = Buffer.from(chunk.data, 'base64')
    if (
      bytes.toString('base64') !== chunk.data ||
      bytes.length === 0 ||
      pending.bytes + bytes.length > pending.length
    ) {
      throw new Error('OMP RPC chunk payload is invalid')
    }
    pending.parts.push(bytes)
    pending.bytes += bytes.length
    pending.next++
    if (pending.next !== pending.count) {
      return []
    }
    this.pending = undefined
    if (pending.bytes !== pending.length) {
      throw new Error('OMP RPC chunk length is invalid')
    }
    return [
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(pending.parts)))
    ]
  }
}

export function encodeOmpRpcFrame(frame: unknown): string {
  const json = JSON.stringify(frame)
  if (Buffer.byteLength(json) + 1 > 64 * 1024 * 1024) {
    throw new Error('OMP RPC request exceeds the local write limit')
  }
  return `${json}\n`
}
