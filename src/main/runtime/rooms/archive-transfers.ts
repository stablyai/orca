import { randomUUID } from 'node:crypto'
import type { RoomArchive, RoomArchiveImportReport } from './archive'
import { MAX_ROOM_ARCHIVE_BYTES } from './archive-codec'
import { decodeCanonicalBase64 } from './canonical-base64'

export const ROOM_ARCHIVE_CHUNK_BYTES = 384 * 1024
const TRANSFER_TTL_MS = 5 * 60_000
const MAX_ACTIVE_TRANSFERS = 4
const MAX_RETAINED_BYTES = MAX_ROOM_ARCHIVE_BYTES * 2

type ExportTransfer = {
  kind: 'export'
  roomId: string
  bytes: Buffer
  fileName: string
  touchedAt: number
}
type ImportTransfer = {
  kind: 'import'
  roomId: string
  chunks: Buffer[]
  byteLength: number
  touchedAt: number
}
type ArchiveTransfer = ExportTransfer | ImportTransfer

export class RoomArchiveTransferStore {
  private readonly transfers = new Map<string, ArchiveTransfer>()
  private pendingExports = 0
  private reservedBytes = 0
  private generation = 0
  private readonly roomGenerations = new Map<string, number>()

  constructor(private readonly archive: RoomArchive) {}

  async startExport(
    roomId: string,
    fileName: string
  ): Promise<{
    transferId: string
    fileName: string
    byteLength: number
    chunkBytes: number
  }> {
    this.reserve(MAX_ROOM_ARCHIVE_BYTES)
    this.pendingExports += 1
    this.reservedBytes += MAX_ROOM_ARCHIVE_BYTES
    const generation = this.generation
    const roomGeneration = this.roomGenerations.get(roomId) ?? 0
    try {
      const bytes = await this.archive.export(roomId)
      if (
        generation !== this.generation ||
        roomGeneration !== (this.roomGenerations.get(roomId) ?? 0)
      ) {
        throw new Error('room_archive_transfer_not_found')
      }
      if (bytes.byteLength > MAX_ROOM_ARCHIVE_BYTES) {
        throw new Error('room_archive_too_large')
      }
      const transferId = randomUUID()
      this.transfers.set(transferId, {
        kind: 'export',
        roomId,
        bytes,
        fileName,
        touchedAt: Date.now()
      })
      return {
        transferId,
        fileName,
        byteLength: bytes.byteLength,
        chunkBytes: ROOM_ARCHIVE_CHUNK_BYTES
      }
    } finally {
      this.pendingExports -= 1
      this.reservedBytes -= MAX_ROOM_ARCHIVE_BYTES
    }
  }

  readExport(
    transferId: string,
    offset: number
  ): {
    contentBase64: string
    nextOffset: number
    done: boolean
  } {
    const transfer = this.get(transferId, 'export')
    if (!Number.isInteger(offset) || offset < 0 || offset > transfer.bytes.byteLength) {
      throw new Error('room_archive_offset_invalid')
    }
    transfer.touchedAt = Date.now()
    const nextOffset = Math.min(offset + ROOM_ARCHIVE_CHUNK_BYTES, transfer.bytes.byteLength)
    return {
      contentBase64: transfer.bytes.subarray(offset, nextOffset).toString('base64'),
      nextOffset,
      done: nextOffset === transfer.bytes.byteLength
    }
  }

  startImport(roomId: string): { transferId: string; chunkBytes: number } {
    this.reserve()
    const transferId = randomUUID()
    this.transfers.set(transferId, {
      kind: 'import',
      roomId,
      chunks: [],
      byteLength: 0,
      touchedAt: Date.now()
    })
    return { transferId, chunkBytes: ROOM_ARCHIVE_CHUNK_BYTES }
  }

  appendImport(transferId: string, contentBase64: string): { byteLength: number } {
    const transfer = this.get(transferId, 'import')
    const chunk = decodeCanonicalBase64(contentBase64, ROOM_ARCHIVE_CHUNK_BYTES)
    if (!chunk || chunk.byteLength > ROOM_ARCHIVE_CHUNK_BYTES) {
      throw new Error('room_archive_chunk_invalid')
    }
    if (transfer.byteLength + chunk.byteLength > MAX_ROOM_ARCHIVE_BYTES) {
      this.transfers.delete(transferId)
      throw new Error('room_archive_too_large')
    }
    this.ensureBytes(chunk.byteLength)
    transfer.chunks.push(chunk)
    transfer.byteLength += chunk.byteLength
    transfer.touchedAt = Date.now()
    return { byteLength: transfer.byteLength }
  }

  async finishImport(transferId: string): Promise<{
    roomId: string
    report: RoomArchiveImportReport
  }> {
    const transfer = this.get(transferId, 'import')
    this.transfers.delete(transferId)
    if (transfer.byteLength === 0) {
      throw new Error('room_archive_empty')
    }
    const report = await this.archive.import(transfer.roomId, Buffer.concat(transfer.chunks))
    return { roomId: transfer.roomId, report }
  }

  importRoomId(transferId: string): string {
    return this.get(transferId, 'import').roomId
  }

  cancel(transferId: string): void {
    this.transfers.delete(transferId)
  }

  cancelRoom(roomId: string): void {
    this.roomGenerations.set(roomId, (this.roomGenerations.get(roomId) ?? 0) + 1)
    for (const [id, transfer] of this.transfers) {
      if (transfer.roomId === roomId) {
        this.transfers.delete(id)
      }
    }
  }

  forgetRoom(roomId: string): void {
    this.roomGenerations.delete(roomId)
  }

  clear(): void {
    this.generation += 1
    this.transfers.clear()
    this.roomGenerations.clear()
  }

  private reserve(bytes = 0): void {
    this.cleanup()
    if (this.transfers.size + this.pendingExports >= MAX_ACTIVE_TRANSFERS) {
      throw new Error('room_archive_transfers_busy')
    }
    this.ensureBytes(bytes)
  }

  private ensureBytes(bytes: number): void {
    let retained = this.reservedBytes
    for (const transfer of this.transfers.values()) {
      retained += transfer.kind === 'export' ? transfer.bytes.byteLength : transfer.byteLength
    }
    if (retained + bytes > MAX_RETAINED_BYTES) {
      throw new Error('room_archive_transfers_busy')
    }
  }

  private cleanup(): void {
    const now = Date.now()
    for (const [id, transfer] of this.transfers) {
      if (now - transfer.touchedAt > TRANSFER_TTL_MS) {
        this.transfers.delete(id)
      }
    }
  }

  private get<TKind extends ArchiveTransfer['kind']>(
    transferId: string,
    kind: TKind
  ): Extract<ArchiveTransfer, { kind: TKind }> {
    const transfer = this.transfers.get(transferId)
    if (!transfer || transfer.kind !== kind) {
      throw new Error('room_archive_transfer_not_found')
    }
    if (Date.now() - transfer.touchedAt > TRANSFER_TTL_MS) {
      this.transfers.delete(transferId)
      throw new Error('room_archive_transfer_expired')
    }
    return transfer as Extract<ArchiveTransfer, { kind: TKind }>
  }
}
