import { randomUUID } from 'node:crypto'
import { lstat, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assertClipboardImageByteLengthWithinLimit } from '../../shared/clipboard-image'
import type { ClipboardImageImport } from '../../shared/clipboard-image-import'
import {
  ensureOwnedTempStagingRoot,
  getOwnedTempStagingRoot,
  isDirectChild,
  isMissingPathError,
  isSafeOwnedDirectory,
  removeOwnedDirectory,
  sweepExpiredOwnedDirectories
} from './owned-temp-staging-root'

const STAGING_TTL_MS = 24 * 60 * 60 * 1000
// Retain up to 50 explorer undo steps, with room for active imports and asynchronous cleanup.
const MAX_STAGED_IMAGES = 64
const MAX_PENDING_IMAGES = 8
const HANDLE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export class ClipboardImageImportStaging {
  private readonly root: string
  private readonly entries = new Map<string, number>()
  private readonly pending = new Set<string>()

  constructor(userDataPath: string) {
    // Each app profile owns its cleanup; another running profile may still be importing.
    this.root = getOwnedTempStagingRoot(userDataPath, 'clipboard-image-imports')
  }

  async stage(ownerId: number, buffer: Buffer, signal: AbortSignal): Promise<ClipboardImageImport> {
    signal.throwIfAborted()
    assertClipboardImageByteLengthWithinLimit(buffer.byteLength)
    if (buffer.byteLength === 0) {
      throw new Error('Clipboard image is empty')
    }
    if (
      this.entries.size + this.pending.size >= MAX_STAGED_IMAGES ||
      this.pending.size >= MAX_PENDING_IMAGES
    ) {
      throw new Error('Too many clipboard image imports in progress')
    }
    const snapshot = Buffer.from(buffer)
    const handle = randomUUID()
    const directory = this.directoryFor(handle)
    const filePath = join(directory, 'pasted-image.png')
    this.pending.add(handle)
    let created = false
    try {
      await this.ensureRoot()
      signal.throwIfAborted()
      await mkdir(directory, { mode: 0o700 })
      created = true
      if (!isSafeOwnedDirectory(await lstat(directory))) {
        throw new Error('Clipboard image import directory is unsafe')
      }
      signal.throwIfAborted()
      await writeFile(filePath, snapshot, { flag: 'wx', mode: 0o600 })
      signal.throwIfAborted()
      this.entries.set(handle, ownerId)
      return { handle, path: filePath }
    } catch (error) {
      if (created) {
        await this.remove(handle).catch((cleanupError) => {
          console.error('[clipboard] Failed to clean image import staging', cleanupError)
        })
      }
      throw error
    } finally {
      this.pending.delete(handle)
    }
  }

  async release(ownerId: number, handle: unknown): Promise<boolean> {
    if (typeof handle !== 'string' || this.entries.get(handle) !== ownerId) {
      return false
    }
    await this.remove(handle)
    this.entries.delete(handle)
    return true
  }

  async releaseOwner(ownerId: number): Promise<void> {
    const results = await Promise.allSettled(
      [...this.entries]
        .filter(([, owner]) => owner === ownerId)
        .map(([handle]) =>
          this.release(ownerId, handle).finally(() => {
            // A lost renderer cannot retry; leave failures eligible for the expired-file sweep.
            this.entries.delete(handle)
          })
        )
    )
    for (const result of results) {
      if (result.status === 'rejected') {
        console.error('[clipboard] Failed to release image import staging', result.reason)
      }
    }
  }

  async sweepExpired(nowMs = Date.now()): Promise<void> {
    await this.ensureRoot()
    await sweepExpiredOwnedDirectories(this.root, {
      nowMs,
      ttlMs: STAGING_TTL_MS,
      ownsEntry: (name) =>
        HANDLE_PATTERN.test(name) && !this.entries.has(name) && !this.pending.has(name)
    })
  }

  private directoryFor(handle: string): string {
    const directory = join(this.root, handle)
    if (!HANDLE_PATTERN.test(handle) || !isDirectChild(this.root, directory)) {
      throw new Error('Invalid clipboard image import handle')
    }
    return directory
  }

  private async ensureRoot(): Promise<void> {
    if (!(await ensureOwnedTempStagingRoot(this.root))) {
      throw new Error('Clipboard image import staging root is unsafe')
    }
  }

  private async remove(handle: string): Promise<void> {
    const directory = this.directoryFor(handle)
    await this.ensureRoot()
    try {
      if (!isSafeOwnedDirectory(await lstat(directory))) {
        throw new Error('Clipboard image import directory is unsafe')
      }
      await removeOwnedDirectory(directory)
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error
      }
    }
  }
}
