import { createHash, randomUUID, type Hash } from 'node:crypto'
import { createReadStream, rmSync } from 'node:fs'
import { mkdir, open, rm, stat, type FileHandle } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getAppEnvironment } from '../../../shared/app-environment'
import {
  CHAT_FORK_TRANSFER_CHUNK_BYTES,
  CHAT_FORK_TRANSFER_IDLE_MS,
  CHAT_FORK_TRANSFER_MAX_BYTES
} from '../../../shared/ai-vault/fork-transfer/chat-fork-transfer-limits'
import { ChatForkImportLaunches } from './chat-fork-import-launches'
import {
  ChatForkTransferError,
  type ChatForkImportLaunch,
  type StagedChatForkImport,
  type StagedChatForkImportTarget
} from './chat-fork-transfer-ownership'
import {
  clearChatForkIdleTimer,
  ownedChatForkEntry as owned,
  reserveChatForkSlot,
  restartChatForkIdleTimer,
  type Timed
} from './chat-fork-transfer-slots'

type ExportEntry = Timed & { directory: string; filePath: string | null; byteLength: number }

type ImportEntry = Timed & {
  filePath: string
  handle: FileHandle
  hash: Hash
  written: number
  busy: boolean
  commit: Promise<ChatForkImportLaunch> | null
  declared: StagedChatForkImportTarget & { byteLength: number; sha256: string }
}

/** Staged chat transcripts moving between hosts; every id is host-minted and bound to its caller. */
export class ChatForkTransferStore {
  private readonly exports = new Map<string, ExportEntry>()
  private readonly imports = new Map<string, ImportEntry>()
  /** Begun imports still opening their staging file; they hold a slot like an open import. */
  private readonly opening = new Map<string, { owner: string }>()
  private readonly launches: ChatForkImportLaunches
  private ready: Promise<void> | null = null
  private disposed = false

  constructor(
    private readonly root: string,
    private readonly idleMs = CHAT_FORK_TRANSFER_IDLE_MS
  ) {
    this.launches = new ChatForkImportLaunches(idleMs)
  }

  async createExport(
    owner: string,
    produce: (directory: string) => Promise<{ filePath: string }>
  ): Promise<{ exportId: string; byteLength: number; sha256: string }> {
    await this.prepare()
    reserveChatForkSlot([this.exports.values()], owner)
    const exportId = randomUUID()
    const directory = join(this.root, 'exports', exportId)
    const entry: ExportEntry = { owner, timer: null, directory, filePath: null, byteLength: 0 }
    this.exports.set(exportId, entry)
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const { filePath } = await produce(directory)
      if (dirname(filePath) !== directory) {
        throw new ChatForkTransferError('chat_fork_source_unavailable')
      }
      const { size } = await stat(filePath)
      if (size > CHAT_FORK_TRANSFER_MAX_BYTES) {
        throw new ChatForkTransferError('chat_fork_transfer_too_large')
      }
      if (size === 0) {
        throw new ChatForkTransferError('chat_fork_source_unavailable')
      }
      const sha256 = await hashFile(filePath)
      if (!this.exports.has(exportId)) {
        throw new ChatForkTransferError('chat_fork_transfer_not_found')
      }
      entry.filePath = filePath
      entry.byteLength = size
      restartChatForkIdleTimer(entry, this.idleMs, () => this.disposeExport(exportId))
      return { exportId, byteLength: size, sha256 }
    } catch (error) {
      this.disposeExport(exportId)
      throw error
    }
  }

  async readExport(
    owner: string,
    exportId: string,
    offset: number,
    length: number
  ): Promise<{ bytesBase64: string; eof: boolean }> {
    const entry = owned(this.exports, exportId, owner)
    if (!entry.filePath) {
      throw new ChatForkTransferError('chat_fork_transfer_not_found')
    }
    if (offset > entry.byteLength) {
      throw new ChatForkTransferError('chat_fork_transfer_offset_mismatch')
    }
    const wanted = Math.min(length, CHAT_FORK_TRANSFER_CHUNK_BYTES, entry.byteLength - offset)
    const buffer = Buffer.alloc(wanted)
    const handle = await open(entry.filePath, 'r')
    try {
      const { bytesRead } = await handle.read(buffer, 0, wanted, offset)
      if (bytesRead !== wanted) {
        throw new ChatForkTransferError('chat_fork_transfer_integrity_failed')
      }
    } finally {
      await handle.close()
    }
    restartChatForkIdleTimer(entry, this.idleMs, () => this.disposeExport(exportId))
    return { bytesBase64: buffer.toString('base64'), eof: offset + wanted >= entry.byteLength }
  }

  releaseExport(owner: string, exportId: string): boolean {
    if (this.exports.get(exportId)?.owner !== owner) {
      return false
    }
    this.disposeExport(exportId)
    return true
  }

  async beginImport(
    owner: string,
    declared: StagedChatForkImportTarget & { byteLength: number; sha256: string }
  ): Promise<{ importId: string; chunkBytes: number }> {
    await this.prepare()
    if (declared.byteLength > CHAT_FORK_TRANSFER_MAX_BYTES) {
      throw new ChatForkTransferError('chat_fork_transfer_too_large')
    }
    // Reserved synchronously, so begins racing in one tick cannot all pass the cap.
    reserveChatForkSlot([this.imports.values(), this.opening.values()], owner)
    const importId = randomUUID()
    const filePath = join(this.root, 'imports', `${importId}.jsonl`)
    this.opening.set(importId, { owner })
    let handle: FileHandle
    try {
      await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
      handle = await open(filePath, 'wx', 0o600)
    } finally {
      this.opening.delete(importId)
    }
    if (this.disposed) {
      await handle.close().catch(() => undefined)
      await rm(filePath, { force: true }).catch(() => undefined)
      throw new ChatForkTransferError('chat_fork_transfer_not_found')
    }
    const entry: ImportEntry = {
      owner,
      timer: null,
      filePath,
      handle,
      hash: createHash('sha256'),
      written: 0,
      busy: false,
      commit: null,
      declared
    }
    this.imports.set(importId, entry)
    restartChatForkIdleTimer(entry, this.idleMs, () => void this.disposeImport(importId))
    return { importId, chunkBytes: CHAT_FORK_TRANSFER_CHUNK_BYTES }
  }

  async appendImport(
    owner: string,
    importId: string,
    offset: number,
    bytes: Buffer
  ): Promise<{ acknowledgedOffset: number }> {
    const entry = owned(this.imports, importId, owner)
    if (entry.busy) {
      throw new ChatForkTransferError('chat_fork_transfer_busy')
    }
    if (bytes.length === 0 || bytes.length > CHAT_FORK_TRANSFER_CHUNK_BYTES) {
      throw new ChatForkTransferError('chat_fork_transfer_integrity_failed')
    }
    if (offset !== entry.written) {
      // A retried chunk the host already holds is acknowledged as that chunk, never written twice.
      if (offset + bytes.length <= entry.written) {
        return { acknowledgedOffset: offset + bytes.length }
      }
      throw new ChatForkTransferError('chat_fork_transfer_offset_mismatch')
    }
    if (entry.written + bytes.length > entry.declared.byteLength) {
      void this.disposeImport(importId)
      throw new ChatForkTransferError('chat_fork_transfer_too_large')
    }
    entry.busy = true
    try {
      await entry.handle.write(bytes, 0, bytes.length, offset)
    } catch (error) {
      void this.disposeImport(importId)
      throw error
    } finally {
      entry.busy = false
    }
    entry.hash.update(bytes)
    entry.written += bytes.length
    restartChatForkIdleTimer(entry, this.idleMs, () => void this.disposeImport(importId))
    return { acknowledgedOffset: entry.written }
  }

  /** Verifies the upload, hands it to `place`, records the launch, and always removes the staged
   *  file. A retried commit (lost reply) gets the same placement instead of a second copy. */
  commitImport(
    owner: string,
    importId: string,
    place: (staged: StagedChatForkImport) => Promise<ChatForkImportLaunch>
  ): Promise<ChatForkImportLaunch> {
    const entry = this.imports.get(importId)
    if (entry?.owner !== owner) {
      const placed = this.launches.find(owner, importId)
      return placed
        ? Promise.resolve(placed)
        : Promise.reject(new ChatForkTransferError('chat_fork_transfer_not_found'))
    }
    if (entry.commit) {
      return entry.commit
    }
    if (entry.busy) {
      return Promise.reject(new ChatForkTransferError('chat_fork_transfer_busy'))
    }
    entry.busy = true
    clearChatForkIdleTimer(entry)
    entry.commit = this.placeImport(owner, importId, entry, place)
    return entry.commit
  }

  cancelImport(owner: string, importId: string): boolean {
    const entry = this.imports.get(importId)
    if (entry?.owner !== owner || entry.busy) {
      return false
    }
    void this.disposeImport(importId)
    return true
  }

  findLaunch(owner: string, importId: string): ChatForkImportLaunch | null {
    return this.launches.find(owner, importId)
  }

  /** Wipes staging left by an earlier run, which can never be resumed. */
  prepare(): Promise<void> {
    this.ready ??= rm(this.root, { recursive: true, force: true })
    return this.ready
  }

  /** Closes every open upload and drops all staging; synchronous so it finishes before quit. */
  dispose(): void {
    this.disposed = true
    for (const id of this.exports.keys()) {
      this.disposeExport(id)
    }
    this.launches.clear()
    for (const id of this.imports.keys()) {
      void this.disposeImport(id)
    }
    try {
      rmSync(this.root, { recursive: true, force: true })
    } catch {
      // A file still held open (Windows) is wiped by the next run's prepare().
    }
  }

  private async placeImport(
    owner: string,
    importId: string,
    entry: ImportEntry,
    place: (staged: StagedChatForkImport) => Promise<ChatForkImportLaunch>
  ): Promise<ChatForkImportLaunch> {
    try {
      await entry.handle.close()
      const { byteLength, sha256, ...target } = entry.declared
      if (entry.written !== byteLength || entry.hash.digest('hex') !== sha256) {
        throw new ChatForkTransferError('chat_fork_transfer_integrity_failed')
      }
      const placed = await place({ ...target, filePath: entry.filePath })
      this.launches.record(owner, importId, placed)
      return placed
    } finally {
      await this.disposeImport(importId)
    }
  }

  private disposeExport(id: string): void {
    const entry = this.exports.get(id)
    if (!entry) {
      return
    }
    clearChatForkIdleTimer(entry)
    this.exports.delete(id)
    void rm(entry.directory, { recursive: true, force: true }).catch(() => undefined)
  }

  private async disposeImport(id: string): Promise<void> {
    const entry = this.imports.get(id)
    if (!entry) {
      return
    }
    clearChatForkIdleTimer(entry)
    this.imports.delete(id)
    await entry.handle.close().catch(() => undefined)
    await rm(entry.filePath, { force: true }).catch(() => undefined)
  }
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk)
  }
  return hash.digest('hex')
}

let store: ChatForkTransferStore | null = null

export function chatForkTransferStore(): ChatForkTransferStore {
  store ??= new ChatForkTransferStore(
    join(getAppEnvironment().getPath('userData'), 'chat-fork-transfers')
  )
  return store
}
