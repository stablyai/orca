import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  MAX_PTY_OWNERSHIP_TRANSFER_JOURNALS,
  type PtyOwnershipTransferIdentity
} from '../../../shared/pty-ownership-transfer-journal'
import { parsePtyOwnershipTransferWireIdentity } from '../../../shared/pty-ownership-transfer-wire'
import { durableWriteTempPath, writeFileDurableSync } from '../../durable-file-write'
import { boundedPositive } from './pty-ownership-transfer-output-outbox-capacity'
import {
  parseOutputOutboxRecord,
  type PtyOwnershipTransferOutputOutboxRecord
} from './pty-ownership-transfer-destination-output-outbox-record'

export const PTY_OWNERSHIP_TRANSFER_OUTPUT_OUTBOX_MAX_BYTES = 4 * 1024 * 1024
export const PTY_OWNERSHIP_TRANSFER_OUTPUT_OUTBOX_MAX_FRAMES = 65_536
const OUTPUT_OUTBOX_FILE_MAX_BYTES = 32 * 1024 * 1024
type OutputOutboxOptions = Readonly<{
  directory: string
  maxBytes?: number
  maxFrames?: number
  maxRecords?: number
}>

export class PtyOwnershipTransferOutputOutboxStorage {
  protected readonly maxBytes: number
  protected readonly maxFrames: number
  protected readonly maxRecords: number

  constructor(protected readonly options: OutputOutboxOptions) {
    this.maxBytes = boundedPositive(
      options.maxBytes ?? PTY_OWNERSHIP_TRANSFER_OUTPUT_OUTBOX_MAX_BYTES,
      PTY_OWNERSHIP_TRANSFER_OUTPUT_OUTBOX_MAX_BYTES
    )
    this.maxFrames = boundedPositive(
      options.maxFrames ?? PTY_OWNERSHIP_TRANSFER_OUTPUT_OUTBOX_MAX_FRAMES,
      PTY_OWNERSHIP_TRANSFER_OUTPUT_OUTBOX_MAX_FRAMES
    )
    this.maxRecords = boundedPositive(
      options.maxRecords ?? MAX_PTY_OWNERSHIP_TRANSFER_JOURNALS,
      MAX_PTY_OWNERSHIP_TRANSFER_JOURNALS
    )
  }

  protected loadRecord(
    identity: PtyOwnershipTransferIdentity
  ): PtyOwnershipTransferOutputOutboxRecord | null {
    const path = this.recordPath(identity.bridgeId)
    if (!existsSync(path)) {
      return null
    }
    try {
      const size = statSync(path).size
      if (size <= 0 || size > OUTPUT_OUTBOX_FILE_MAX_BYTES) {
        throw new Error('pty_ownership_transfer_output_outbox_file_size_invalid')
      }
      return parseOutputOutboxRecord(JSON.parse(readFileSync(path, 'utf8')) as unknown, identity, {
        maxBytes: this.maxBytes,
        maxFrames: this.maxFrames
      })
    } catch (error) {
      throw new Error('pty_ownership_transfer_output_outbox_invalid', { cause: error })
    }
  }

  protected requireRecord(
    identity: PtyOwnershipTransferIdentity
  ): PtyOwnershipTransferOutputOutboxRecord {
    const validated = parsePtyOwnershipTransferWireIdentity(identity)
    const record = this.loadRecord(validated)
    if (!record) {
      throw new Error('pty_ownership_transfer_output_outbox_not_open')
    }
    return record
  }

  protected persist(record: PtyOwnershipTransferOutputOutboxRecord): void {
    mkdirSync(this.options.directory, { recursive: true, mode: 0o700 })
    const path = this.recordPath(record.identity.bridgeId)
    const data = `${JSON.stringify(record)}\n`
    if (Buffer.byteLength(data, 'utf8') > OUTPUT_OUTBOX_FILE_MAX_BYTES) {
      throw new Error('pty_ownership_transfer_output_outbox_file_size_invalid')
    }
    writeFileDurableSync(durableWriteTempPath(path), path, data)
  }

  private recordPath(bridgeId: string): string {
    return join(
      this.options.directory,
      `${createHash('sha256').update(bridgeId).digest('hex')}.json`
    )
  }
}
