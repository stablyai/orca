import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import {
  BROWSER_CLIENT_FILE_CHANNEL_MAX_FILES_PER_COMMAND,
  BROWSER_CLIENT_FILE_CHANNEL_TRANSFER_MAX_BYTES
} from '../../shared/browser-client-file-channel-protocol'
import { normalizeBrowserDownloadFilename } from '../../shared/browser-download-filename'

export type BrowserClientStagedUpload = {
  stagingId: string
  localFilePaths: readonly string[]
}

// Why: staged copies outlive the command (Chromium opens them lazily), so a long-lived page needs a
// ceiling. Both bounds admit at least one maximum-sized command so a legal upload is never evicted
// before the guest reads it.
export const BROWSER_CLIENT_UPLOAD_STAGING_MAX_COMMANDS_PER_PAGE = 4
export const BROWSER_CLIENT_UPLOAD_STAGING_MAX_BYTES_PER_PAGE =
  2 * BROWSER_CLIENT_FILE_CHANNEL_TRANSFER_MAX_BYTES

type StagedDirectory = {
  stagingId: string
  browserPageId: string
  pageHostGeneration: number
  directory: string
  totalBytes: number
}

type StagingFilesystem = {
  mkdir(directory: string): Promise<void>
  writeFile(filePath: string, contents: Buffer): Promise<void>
  removeDirectory(directory: string): Promise<void>
  removeDirectorySync(directory: string): void
}

// Why: Chromium and AV scanners hold a staged file open briefly, which is EBUSY/EPERM on Windows;
// `force` only swallows ENOENT, so without retries a transient handle strands the directory.
const stagingRemovalOptions = {
  recursive: true,
  force: true,
  maxRetries: 3,
  retryDelay: 50
} as const

const nodeStagingFilesystem: StagingFilesystem = {
  mkdir: async (directory) => {
    await mkdir(directory, { recursive: true, mode: 0o700 })
  },
  writeFile: async (filePath, contents) => {
    await writeFile(filePath, contents, { mode: 0o600 })
  },
  removeDirectory: async (directory) => {
    await rm(directory, stagingRemovalOptions)
  },
  removeDirectorySync: (directory) => {
    rmSync(directory, stagingRemovalOptions)
  }
}

/**
 * Owns the desktop-side scratch copies of remote workspace files that a client-placed page uploads.
 * Remote-supplied paths are never resolved against the desktop filesystem; only bytes handed to
 * `stage` reach disk, under a main-owned directory that is removed when the page is fenced or when
 * the page's staged budget evicts it.
 */
export class BrowserClientUploadStaging {
  private readonly staged = new Map<string, StagedDirectory>()
  private readonly filesystem: StagingFilesystem

  constructor(
    private readonly stagingRoot: string,
    filesystem: StagingFilesystem = nodeStagingFilesystem
  ) {
    this.filesystem = filesystem
    try {
      // Why: an abnormal exit leaves staged remote bytes behind, and nothing else ever revisits this
      // root — the scope is a pure function of the environment id, so a relaunch reuses it.
      this.filesystem.removeDirectorySync(stagingRoot)
    } catch {
      // A root that cannot be swept still accepts fresh per-command directories.
    }
  }

  async stage(input: {
    browserPageId: string
    pageHostGeneration: number
    files: readonly { remotePath: string; contents: Buffer }[]
  }): Promise<BrowserClientStagedUpload> {
    if (input.files.length === 0) {
      throw new Error('browser_client_upload_files_required')
    }
    if (input.files.length > BROWSER_CLIENT_FILE_CHANNEL_MAX_FILES_PER_COMMAND) {
      throw new Error('browser_client_upload_file_count_exceeded')
    }
    const totalBytes = input.files.reduce((sum, file) => sum + file.contents.byteLength, 0)
    if (totalBytes > BROWSER_CLIENT_FILE_CHANNEL_TRANSFER_MAX_BYTES) {
      throw new Error('browser_client_upload_too_large')
    }
    const stagingId = randomUUID()
    const directory = path.join(this.stagingRoot, stagingId)
    const record: StagedDirectory = {
      stagingId,
      browserPageId: input.browserPageId,
      pageHostGeneration: input.pageHostGeneration,
      directory,
      totalBytes
    }
    this.staged.set(stagingId, record)
    try {
      await this.filesystem.mkdir(directory)
      const localFilePaths: string[] = []
      for (const [index, file] of input.files.entries()) {
        // Why: one subdirectory per file keeps the exact basename the site receives, with no collisions.
        const fileDirectory = path.join(directory, String(index))
        await this.filesystem.mkdir(fileDirectory)
        const localFilePath = path.join(fileDirectory, stagedFilename(file.remotePath))
        await this.filesystem.writeFile(localFilePath, file.contents)
        localFilePaths.push(localFilePath)
      }
      await this.evictPageOverflow(record)
      return { stagingId, localFilePaths }
    } catch (error) {
      // Why: the staging failure is the one worth reporting; a removal that fails here keeps its
      // record so a later release retries the directory.
      await this.release(stagingId).catch(() => undefined)
      throw error
    }
  }

  /** Drops the page's oldest staged commands until the newest one fits the per-page budget. */
  private async evictPageOverflow(current: StagedDirectory): Promise<void> {
    // Why: Map preserves insertion order, so the page's entries are already oldest-first.
    const owned = [...this.staged.values()].filter(
      (record) => record.browserPageId === current.browserPageId
    )
    let commands = owned.length
    let bytes = owned.reduce((sum, record) => sum + record.totalBytes, 0)
    for (const record of owned) {
      if (
        record.stagingId === current.stagingId ||
        (commands <= BROWSER_CLIENT_UPLOAD_STAGING_MAX_COMMANDS_PER_PAGE &&
          bytes <= BROWSER_CLIENT_UPLOAD_STAGING_MAX_BYTES_PER_PAGE)
      ) {
        break
      }
      commands -= 1
      bytes -= record.totalBytes
      await this.release(record.stagingId)
    }
  }

  async release(stagingId: string): Promise<boolean> {
    const record = this.staged.get(stagingId)
    if (!record) {
      return false
    }
    // Why: every recovery path iterates `staged`, so dropping the record before the removal lands
    // would leave the directory unreachable for the life of the machine.
    await this.filesystem.removeDirectory(record.directory)
    this.staged.delete(stagingId)
    return true
  }

  async releasePage(browserPageId: string, pageHostGeneration?: number): Promise<number> {
    const owned = [...this.staged.values()].filter(
      (record) =>
        record.browserPageId === browserPageId &&
        (pageHostGeneration === undefined || record.pageHostGeneration === pageHostGeneration)
    )
    await this.releaseEach(owned.map((record) => record.stagingId))
    return owned.length
  }

  async releaseAll(): Promise<void> {
    await this.releaseEach(Array.from(this.staged.keys()))
  }

  /** Every id gets an attempt: one directory that cannot be removed must not strand the rest. */
  private async releaseEach(stagingIds: readonly string[]): Promise<void> {
    const failures: unknown[] = []
    for (const stagingId of stagingIds) {
      try {
        await this.release(stagingId)
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Browser client upload staging release failed')
    }
  }

  stagedDirectory(stagingId: string): string | undefined {
    return this.staged.get(stagingId)?.directory
  }

  activeStagingCount(): number {
    return this.staged.size
  }
}

// Why: the guest sees this name in the file input, so keep the remote basename but strip every
// separator and reserved form first — the remote controls this string. Windows rules are applied on
// every platform so a staged name never depends on where the desktop runs.
function stagedFilename(remotePath: string): string {
  const basename = remotePath.replace(/\\/g, '/').split('/').at(-1) ?? ''
  return normalizeBrowserDownloadFilename(basename, 'win32')
}
