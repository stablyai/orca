import { RelayErrorCode } from './relay-protocol'
import { type SshStreamAssemblyBudget, base64EncodedLength } from './ssh-stream-reader-memory'

export class GitResponseStreamError extends Error {
  readonly code = RelayErrorCode.StreamProtocolError
  constructor(message: string) {
    super(message)
  }
}

export class GitResponseStreamAssembler {
  private buffer: Buffer | null
  private expectedSeq = 0
  private receivedBytes = 0
  private releaseBudget: (() => void) | null

  constructor(
    private readonly streamId: number,
    private readonly totalBytes: number,
    private readonly chunkCount: number,
    assemblyBudget: SshStreamAssemblyBudget
  ) {
    this.releaseBudget = assemblyBudget.reserve(totalBytes)
    if (!this.releaseBudget) {
      throw new GitResponseStreamError(
        `Active SSH stream assembly would exceed ${assemblyBudget.maxBytes} bytes`
      )
    }
    try {
      this.buffer = Buffer.alloc(totalBytes)
    } catch (error) {
      this.release()
      throw new GitResponseStreamError(
        `Failed to allocate ${totalBytes} bytes: ${(error as Error).message}`
      )
    }
  }

  acceptChunk(params: Record<string, unknown>): number {
    const seq = params.seq
    const data = params.data
    if (
      typeof seq !== 'number' ||
      !Number.isSafeInteger(seq) ||
      seq < 0 ||
      typeof data !== 'string'
    ) {
      throw new GitResponseStreamError(`Malformed chunk for git stream ${this.streamId}`)
    }
    if (seq !== this.expectedSeq) {
      throw new GitResponseStreamError(
        `Out-of-order chunk for git stream ${this.streamId}: expected ${this.expectedSeq}, got ${seq}`
      )
    }
    if (this.expectedSeq >= this.chunkCount) {
      throw new GitResponseStreamError(
        `Git stream ${this.streamId} exceeded declared chunk count ${this.chunkCount}`
      )
    }
    const remainingBytes = this.totalBytes - this.receivedBytes
    if (data.length > base64EncodedLength(remainingBytes)) {
      throw new GitResponseStreamError(
        `Git stream ${this.streamId} chunk exceeds ${remainingBytes} remaining bytes`
      )
    }
    const decoded = Buffer.from(data, 'base64')
    if (decoded.length > remainingBytes) {
      throw new GitResponseStreamError(
        `Git stream ${this.streamId} decoded beyond its declared size`
      )
    }
    if (!this.buffer) {
      throw new GitResponseStreamError(
        `Chunk arrived after completion for git stream ${this.streamId}`
      )
    }
    decoded.copy(this.buffer, this.receivedBytes)
    this.receivedBytes += decoded.length
    this.expectedSeq += 1
    return seq
  }

  finish(): unknown {
    if (this.expectedSeq !== this.chunkCount || this.receivedBytes !== this.totalBytes) {
      throw new GitResponseStreamError(
        `Git stream ${this.streamId} incomplete: chunks ${this.expectedSeq}/${this.chunkCount}, bytes ${this.receivedBytes}/${this.totalBytes}`
      )
    }
    if (!this.buffer) {
      throw new GitResponseStreamError(`Git stream ${this.streamId} already completed`)
    }
    const serialized = this.buffer.toString('utf-8')
    this.release()
    try {
      return JSON.parse(serialized)
    } catch (error) {
      throw new GitResponseStreamError(
        `Git stream ${this.streamId} JSON parse failed: ${String(error)}`
      )
    }
  }

  release(): void {
    this.buffer = null
    this.releaseBudget?.()
    this.releaseBudget = null
  }
}
