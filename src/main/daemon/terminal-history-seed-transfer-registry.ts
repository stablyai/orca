import { createHash, randomUUID } from 'node:crypto'
import { TERMINAL_HISTORY_CHECKPOINT_MAX_BYTES } from './terminal-history-file-limits'
import { TERMINAL_HISTORY_SEED_CHUNK_CODE_UNITS } from './terminal-history-seed-chunks'
import type { TerminalHistorySeedTransferManifest } from './terminal-history-seed-transfer-protocol'

const MAX_TRANSFERS = 8
const MAX_CHUNKS = 4096
const TRANSFER_TTL_MS = 30_000

type Transfer = {
  ownerId: string
  manifest: TerminalHistorySeedTransferManifest
  chunks: string[]
  codeUnits: number
  utf8Bytes: number
  hash: ReturnType<typeof createHash>
  finished: boolean
  timer: ReturnType<typeof setTimeout>
}

export class TerminalHistorySeedTransferRegistry {
  private transfers = new Map<string, Transfer>()
  private retainedBytes = 0

  constructor(
    private readonly maxRetainedBytes = TERMINAL_HISTORY_CHECKPOINT_MAX_BYTES,
    private readonly transferTtlMs = TRANSFER_TTL_MS
  ) {}

  start(ownerId: string, manifest: TerminalHistorySeedTransferManifest): string {
    this.validateManifest(manifest)
    if (this.transfers.size >= MAX_TRANSFERS) {
      throw new Error('Too many pending terminal history seed transfers')
    }
    const transferId = randomUUID()
    const timer = setTimeout(() => this.delete(transferId), this.transferTtlMs)
    timer.unref()
    this.transfers.set(transferId, {
      ownerId,
      manifest: { ...manifest },
      chunks: [],
      codeUnits: 0,
      utf8Bytes: 0,
      hash: createHash('sha256'),
      finished: false,
      timer
    })
    return transferId
  }

  append(ownerId: string, transferId: string, index: number, data: string): void {
    const transfer = this.getOwned(ownerId, transferId)
    if (transfer.finished) {
      throw new Error('Terminal history seed transfer is already finished')
    }
    if (index !== transfer.chunks.length || index >= transfer.manifest.chunkCount) {
      throw new Error('Terminal history seed chunk sequence mismatch')
    }
    if (data.length === 0 || data.length > TERMINAL_HISTORY_SEED_CHUNK_CODE_UNITS) {
      throw new Error('Terminal history seed chunk size is invalid')
    }
    const utf8Bytes = Buffer.byteLength(data, 'utf8')
    if (
      transfer.codeUnits + data.length > transfer.manifest.codeUnits ||
      this.retainedBytes + utf8Bytes > this.maxRetainedBytes
    ) {
      throw new Error('Terminal history seed transfer exceeds retained byte limit')
    }
    transfer.chunks.push(data)
    transfer.codeUnits += data.length
    transfer.utf8Bytes += utf8Bytes
    transfer.hash.update(Buffer.from(data, 'utf16le'))
    this.retainedBytes += utf8Bytes
    this.refreshExpiry(transferId, transfer)
  }

  finish(ownerId: string, transferId: string): void {
    const transfer = this.getOwned(ownerId, transferId)
    if (transfer.finished) {
      throw new Error('Terminal history seed transfer is already finished')
    }
    if (
      transfer.chunks.length !== transfer.manifest.chunkCount ||
      transfer.codeUnits !== transfer.manifest.codeUnits
    ) {
      throw new Error('Terminal history seed transfer is incomplete')
    }
    const digest = transfer.hash.digest('hex')
    if (digest !== transfer.manifest.sha256) {
      this.delete(transferId)
      throw new Error('Terminal history seed transfer digest mismatch')
    }
    transfer.finished = true
    this.refreshExpiry(transferId, transfer)
  }

  take(ownerId: string, transferId: string): readonly string[] {
    const transfer = this.getOwned(ownerId, transferId)
    if (!transfer.finished) {
      throw new Error('Terminal history seed transfer is not finished')
    }
    const chunks = transfer.chunks
    this.delete(transferId)
    return chunks
  }

  abort(ownerId: string, transferId: string): void {
    this.getOwned(ownerId, transferId)
    this.delete(transferId)
  }

  clearOwner(ownerId: string): void {
    for (const [transferId, transfer] of this.transfers) {
      if (transfer.ownerId === ownerId) {
        this.delete(transferId)
      }
    }
  }

  dispose(): void {
    for (const transferId of this.transfers.keys()) {
      this.delete(transferId)
    }
  }

  private validateManifest(manifest: TerminalHistorySeedTransferManifest): void {
    // Why codeUnits is compared to a byte cap: UTF-8 never encodes a UTF-16 code unit in under one byte,
    // so codeUnits > maxRetainedBytes proves the payload cannot fit. Scaling up for multibyte would
    // reject ASCII seeds that do fit; append() enforces the real byte budget.
    if (
      !Number.isInteger(manifest.chunkCount) ||
      manifest.chunkCount < 1 ||
      manifest.chunkCount > MAX_CHUNKS ||
      !Number.isInteger(manifest.codeUnits) ||
      manifest.codeUnits < 1 ||
      manifest.codeUnits > this.maxRetainedBytes ||
      !/^[a-f0-9]{64}$/.test(manifest.sha256)
    ) {
      throw new Error('Terminal history seed transfer manifest is invalid')
    }
  }

  private getOwned(ownerId: string, transferId: string): Transfer {
    const transfer = this.transfers.get(transferId)
    if (!transfer || transfer.ownerId !== ownerId) {
      throw new Error('Terminal history seed transfer not found')
    }
    return transfer
  }

  private refreshExpiry(transferId: string, transfer: Transfer): void {
    clearTimeout(transfer.timer)
    transfer.timer = setTimeout(() => this.delete(transferId), this.transferTtlMs)
    transfer.timer.unref()
  }

  private delete(transferId: string): void {
    const transfer = this.transfers.get(transferId)
    if (!transfer) {
      return
    }
    clearTimeout(transfer.timer)
    this.retainedBytes -= transfer.utf8Bytes
    this.transfers.delete(transferId)
  }
}
