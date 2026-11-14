import { createHash, randomUUID, type Hash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, rm, stat, type FileHandle } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getAppEnvironment } from '../../../shared/app-environment'
import {
  CHAT_FORK_TRANSFER_CHUNK_BYTES,
  CHAT_FORK_TRANSFER_IDLE_MS,
  CHAT_FORK_TRANSFER_MAX_BYTES,
  CHAT_FORK_TRANSFER_MAX_SESSIONS
} from '../../../shared/ai-vault/fork-transfer/chat-fork-transfer-limits'
import {
  ChatForkTransferError,
  type ChatForkImportLaunch,
  type StagedChatForkImport,
  type StagedChatForkImportTarget
} from './chat-fork-transfer-ownership'

type Timed = { owner: string; timer: ReturnType<typeof setTimeout> | null }

type ExportEntry = Timed & {
  directory: string
  filePath: string | null
  byteLength: number
}

type ImportEntry = Timed & {
  filePath: string
  handle: FileHandle
  hash: Hash
  written: number
  busy: boolean
  declared: StagedChatForkImportTarget & { byteLength: number; sha256: string }
}

type LaunchEntry = Timed & ChatForkImportLaunch

/** Staged chat transcripts moving between hosts; every id is host-minted and bound to its caller. */
export class ChatForkTransferStore {
  private readonly exports = new Map<string, ExportEntry>()
  private readonly imports = new Map<string, ImportEntry>()
  private readonly launches = new Map<string, LaunchEntry>()
  private ready: Promise<void> | null = null

  constructor(
    private readonly root: string,
    private readonly idleMs = CHAT_FORK_TRANSFER_IDLE_MS
  ) {}

  async createExport(
    owner: string,
    produce: (directory: string) => Promise<{ filePath: string }>
  ): Promise<{ exportId: string; byteLength: number; sha256: string }> {
    await this.prepare()
    reserve(this.exports.size)
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
      this.touch(entry, () => this.disposeExport(exportId))
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
    this.touch(entry, () => this.disposeExport(exportId))
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
    reserve(this.imports.size)
    if (declared.byteLength > CHAT_FORK_TRANSFER_MAX_BYTES) {
      throw new ChatForkTransferError('chat_fork_transfer_too_large')
    }
    const importId = randomUUID()
    const filePath = join(this.root, 'imports', `${importId}.jsonl`)
    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
    const handle = await open(filePath, 'wx', 0o600)
    const entry: ImportEntry = {
      owner,
      timer: null,
      filePath,
      handle,
      hash: createHash('sha256'),
      written: 0,
      busy: false,
      declared
    }
    this.imports.set(importId, entry)
    this.touch(entry, () => void this.disposeImport(importId))
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
      // A retried chunk the host already holds is acknowledged, never written twice.
      if (offset + bytes.length <= entry.written) {
        return { acknowledgedOffset: entry.written }
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
    this.touch(entry, () => void this.disposeImport(importId))
    return { acknowledgedOffset: entry.written }
  }

  /** Verifies the upload, hands it to `place`, and always removes the staged file. */
  async commitImport<T>(
    owner: string,
    importId: string,
    place: (staged: StagedChatForkImport) => Promise<T>
  ): Promise<T> {
    const entry = owned(this.imports, importId, owner)
    if (entry.busy) {
      throw new ChatForkTransferError('chat_fork_transfer_busy')
    }
    entry.busy = true
    this.clearTimer(entry)
    try {
      await entry.handle.close()
      const { byteLength, sha256, ...target } = entry.declared
      if (entry.written !== byteLength || entry.hash.digest('hex') !== sha256) {
        throw new ChatForkTransferError('chat_fork_transfer_integrity_failed')
      }
      return await place({ ...target, filePath: entry.filePath })
    } finally {
      await this.disposeImport(importId)
    }
  }

  cancelImport(owner: string, importId: string): boolean {
    const entry = this.imports.get(importId)
    if (entry?.owner !== owner || entry.busy) {
      return false
    }
    void this.disposeImport(importId)
    return true
  }

  recordLaunch(owner: string, importId: string, launch: ChatForkImportLaunch): void {
    const oldest = this.launches.keys().next()
    if (this.launches.size >= CHAT_FORK_TRANSFER_MAX_SESSIONS && !oldest.done) {
      this.disposeLaunch(oldest.value)
    }
    const entry: LaunchEntry = { owner, timer: null, ...launch }
    this.launches.set(importId, entry)
    this.touch(entry, () => this.disposeLaunch(importId))
  }

  /** Not consumed, so a lost-response retry of the same create can still find it. */
  findLaunch(owner: string, importId: string): ChatForkImportLaunch | null {
    const entry = this.launches.get(importId)
    if (entry?.owner !== owner) {
      return null
    }
    const { worktreeId, sessionId, filePath, cwd } = entry
    return { worktreeId, sessionId, filePath, cwd }
  }

  /** Closes every open upload and drops all staging. */
  async dispose(): Promise<void> {
    for (const id of this.exports.keys()) {
      this.disposeExport(id)
    }
    for (const id of this.launches.keys()) {
      this.disposeLaunch(id)
    }
    await Promise.all([...this.imports.keys()].map((id) => this.disposeImport(id)))
  }

  private prepare(): Promise<void> {
    // Staging left by an earlier run can never be resumed.
    this.ready ??= rm(this.root, { recursive: true, force: true })
    return this.ready
  }

  private touch(entry: Timed, expire: () => void): void {
    this.clearTimer(entry)
    entry.timer = setTimeout(expire, this.idleMs)
    entry.timer.unref?.()
  }

  private clearTimer(entry: Timed): void {
    if (entry.timer) {
      clearTimeout(entry.timer)
      entry.timer = null
    }
  }

  private disposeExport(id: string): void {
    const entry = this.exports.get(id)
    if (!entry) {
      return
    }
    this.clearTimer(entry)
    this.exports.delete(id)
    void rm(entry.directory, { recursive: true, force: true }).catch(() => undefined)
  }

  private async disposeImport(id: string): Promise<void> {
    const entry = this.imports.get(id)
    if (!entry) {
      return
    }
    this.clearTimer(entry)
    this.imports.delete(id)
    await entry.handle.close().catch(() => undefined)
    await rm(entry.filePath, { force: true }).catch(() => undefined)
  }

  private disposeLaunch(id: string): void {
    const entry = this.launches.get(id)
    if (entry) {
      this.clearTimer(entry)
      this.launches.delete(id)
    }
  }
}

function reserve(size: number): void {
  if (size >= CHAT_FORK_TRANSFER_MAX_SESSIONS) {
    throw new ChatForkTransferError('chat_fork_transfer_busy')
  }
}

function owned<T extends Timed>(map: Map<string, T>, id: string, owner: string): T {
  const entry = map.get(id)
  // Another caller's id reads as unknown, so ids never leak across devices.
  if (!entry || entry.owner !== owner) {
    throw new ChatForkTransferError('chat_fork_transfer_not_found')
  }
  return entry
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
