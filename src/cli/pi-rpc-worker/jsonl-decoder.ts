import { TextDecoder } from 'node:util'
import type { RpcObject } from './types'

export const MAX_PI_RPC_LINE_BYTES = 4 * 1024 * 1024

export class StrictJsonlDecoder {
  private readonly chunks: Buffer[] = []
  private lineBytes = 0
  private failed = false
  private ended = false

  constructor(
    private readonly onRecord: (record: RpcObject) => void,
    private readonly maxLineBytes = MAX_PI_RPC_LINE_BYTES
  ) {}

  push(chunk: Uint8Array): void {
    if (this.failed || this.ended) {
      throw new Error('JSONL decoder is not writable')
    }
    let start = 0
    for (let index = 0; index < chunk.byteLength; index += 1) {
      if (chunk[index] !== 0x0a) {
        continue
      }
      this.append(chunk.subarray(start, index))
      this.emitLine()
      start = index + 1
    }
    this.append(chunk.subarray(start))
  }

  finish(): void {
    if (this.failed) {
      throw new Error('JSONL decoder failed')
    }
    if (this.ended) {
      throw new Error('JSONL decoder already ended')
    }
    this.ended = true
    if (this.lineBytes !== 0) {
      this.failed = true
      throw new Error('Pi RPC stdout ended with an unterminated JSONL record')
    }
  }

  private append(bytes: Uint8Array): void {
    if (bytes.byteLength === 0) {
      return
    }
    this.lineBytes += bytes.byteLength
    if (this.lineBytes > this.maxLineBytes) {
      this.failed = true
      throw new Error('Pi RPC JSONL record exceeds the inbound byte limit')
    }
    this.chunks.push(Buffer.from(bytes))
  }

  private emitLine(): void {
    let bytes = Buffer.concat(this.chunks, this.lineBytes)
    this.chunks.length = 0
    this.lineBytes = 0
    if (bytes.at(-1) === 0x0d) {
      bytes = bytes.subarray(0, -1)
    }
    if (bytes.byteLength === 0) {
      this.failed = true
      throw new Error('Pi RPC emitted an empty JSONL record')
    }
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      this.failed = true
      throw new Error('Pi RPC emitted invalid UTF-8')
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      this.failed = true
      throw new Error('Pi RPC emitted malformed JSON')
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      this.failed = true
      throw new Error('Pi RPC emitted a non-object JSONL record')
    }
    this.onRecord(parsed as RpcObject)
  }
}
