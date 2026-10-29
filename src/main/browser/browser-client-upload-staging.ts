import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import {
  BROWSER_CLIENT_FILE_CHANNEL_MAX_FILES_PER_COMMAND,
  BROWSER_CLIENT_FILE_CHANNEL_TRANSFER_MAX_BYTES
} from '../../shared/browser-client-file-channel-protocol'
import { normalizeBrowserDownloadFilename } from '../../shared/browser-download-filename'
import { removeTree } from '../../shared/windows-transient-lock-removal'

export type BrowserClientStagedUpload = {
  stagingId: string
  localFilePaths: readonly string[]
}

// Bound copies retained for Chromium’s lazy reads on long-lived pages.
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

// Chromium or antivirus handles can transiently block removal; rmSync's native retries are top-level only.
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
    await removeTree(directory)
  },
  removeDirectorySync: (directory) => {
    rmSync(directory, stagingRemovalOptions)
  }
}

/** Remote paths supply filenames only; staged bytes stay in a main-owned directory. */
export class BrowserClientUploadStaging {
  private readonly staged = new Map<string, StagedDirectory>()
  private readonly filesystem: StagingFilesystem

  constructor(
    private readonly stagingRoot: string,
    filesystem: StagingFilesystem = nodeStagingFilesystem
  ) {
    this.filesystem = filesystem
    try {
      // Sweep crash leftovers from the staging root reused across relaunches.
      this.filesystem.removeDirectorySync(stagingRoot)
    } catch {
      // Let new commands try even if startup cleanup fails.
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
        // Separate directories keep sanitized basenames from colliding.
        const fileDirectory = path.join(directory, String(index))
        await this.filesystem.mkdir(fileDirectory)
        const localFilePath = path.join(fileDirectory, stagedFilename(file.remotePath))
        await this.filesystem.writeFile(localFilePath, file.contents)
        localFilePaths.push(localFilePath)
      }
      await this.evictPageOverflow(record)
      return { stagingId, localFilePaths }
    } catch (error) {
      // Preserve the staging error; failed cleanup remains recorded for a later retry.
      await this.release(stagingId).catch(() => undefined)
      throw error
    }
  }

  private async evictPageOverflow(current: StagedDirectory): Promise<void> {
    // Map insertion order already puts the oldest commands first.
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
    // Keep the record until removal succeeds so page cleanup can retry.
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

  /** Attempt every directory before reporting cleanup failures. */
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

// Apply Windows filename rules everywhere for consistent, safe upload basenames.
function stagedFilename(remotePath: string): string {
  const basename = remotePath.replace(/\\/g, '/').split('/').at(-1) ?? ''
  return normalizeBrowserDownloadFilename(basename, 'win32')
}
