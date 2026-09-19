import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  rmSync
} from 'node:fs'
import type { Stats } from 'node:fs'
import { join } from 'node:path'
import {
  durableWriteTempPath,
  syncDirectoryDurablySync,
  writeFileDurableSync
} from '../main/durable-file-write'
import { MAX_PTY_OWNERSHIP_TRANSFER_JOURNALS } from '../shared/pty-ownership-transfer-journal-contract'
import type {
  RelayPtyOwnershipTransferDurableRecord,
  RelayPtyOwnershipTransferStore
} from './relay-pty-ownership-transfer-adapter-contract'

const RECORD_NAME = /^[a-f0-9]{64}\.json$/
const MAX_RECORD_BYTES = 8 * 1024 * 1024

type RelayPtyOwnershipTransferFileStoreFs = Readonly<{
  closeSync: typeof closeSync
  fstatSync: (fd: number) => Pick<Stats, 'size'>
  openSync: typeof openSync
  readSync: typeof readSync
}>

const defaultFileStoreFs: RelayPtyOwnershipTransferFileStoreFs = {
  closeSync,
  fstatSync,
  openSync,
  readSync
}

/** Owner-private, bounded per-bridge records with fsynced atomic replacement. */
export class RelayPtyOwnershipTransferFileStore implements RelayPtyOwnershipTransferStore {
  constructor(
    private readonly directory: string,
    private readonly fileStoreFs: RelayPtyOwnershipTransferFileStoreFs = defaultFileStoreFs
  ) {}

  loadAll(): readonly RelayPtyOwnershipTransferDurableRecord[] {
    if (!existsSync(this.directory)) {
      return []
    }
    const names = readdirSync(this.directory)
      .filter((name) => RECORD_NAME.test(name))
      .sort()
    if (names.length > MAX_PTY_OWNERSHIP_TRANSFER_JOURNALS) {
      throw invalidStore()
    }
    return names.map((name) => this.readRecord(name))
  }

  save(record: RelayPtyOwnershipTransferDurableRecord): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const payload = `${JSON.stringify(record)}\n`
    if (Buffer.byteLength(payload, 'utf8') > MAX_RECORD_BYTES) {
      throw invalidStore()
    }
    const path = this.recordPath(record.identity.bridgeId)
    if (!existsSync(path) && this.recordCount() >= MAX_PTY_OWNERSHIP_TRANSFER_JOURNALS) {
      throw new Error('pty_ownership_transfer_relay_store_capacity_exceeded')
    }
    const temporaryPath = durableWriteTempPath(path)
    const descriptor = openSync(temporaryPath, 'wx', 0o600)
    closeSync(descriptor)
    writeFileDurableSync(temporaryPath, path, payload)
  }

  remove(bridgeId: string): void {
    const path = this.recordPath(bridgeId)
    if (!existsSync(path)) {
      return
    }
    rmSync(path)
    syncDirectoryDurablySync(this.directory)
  }

  private readRecord(name: string): RelayPtyOwnershipTransferDurableRecord {
    const path = join(this.directory, name)
    let descriptor: number | undefined
    try {
      descriptor = this.fileStoreFs.openSync(path, 'r')
      // Keep the size check on the opened inode, then cap the actual read so a
      // concurrent writer cannot turn the check into an unbounded allocation.
      if (this.fileStoreFs.fstatSync(descriptor).size > MAX_RECORD_BYTES) {
        throw invalidStore()
      }
      const payload = Buffer.allocUnsafe(MAX_RECORD_BYTES + 1)
      let bytesRead = 0
      while (bytesRead < payload.length) {
        const read = this.fileStoreFs.readSync(
          descriptor,
          payload,
          bytesRead,
          payload.length - bytesRead,
          null
        )
        if (read === 0) {
          break
        }
        bytesRead += read
      }
      if (bytesRead > MAX_RECORD_BYTES) {
        throw invalidStore()
      }
      const value = JSON.parse(
        payload.subarray(0, bytesRead).toString('utf8')
      ) as RelayPtyOwnershipTransferDurableRecord
      if (name !== this.recordName(value?.identity?.bridgeId)) {
        throw invalidStore()
      }
      return value
    } catch (error) {
      throw new Error('pty_ownership_transfer_relay_store_invalid', { cause: error })
    } finally {
      if (descriptor !== undefined) {
        this.fileStoreFs.closeSync(descriptor)
      }
    }
  }

  private recordCount(): number {
    return readdirSync(this.directory).filter((name) => RECORD_NAME.test(name)).length
  }

  private recordPath(bridgeId: string): string {
    return join(this.directory, this.recordName(bridgeId))
  }

  private recordName(bridgeId: unknown): string {
    if (typeof bridgeId !== 'string' || bridgeId.length === 0) {
      throw invalidStore()
    }
    return `${createHash('sha256').update(bridgeId).digest('hex')}.json`
  }
}

function invalidStore(): Error {
  return new Error('pty_ownership_transfer_relay_store_invalid')
}
