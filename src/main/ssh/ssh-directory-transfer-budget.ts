export type SshDirectoryTransferLimits = {
  maximumEntries: number
  maximumDepth: number
  maximumPathBytes: number
  maximumRetainedPathBytes: number
  maximumFileBytes: number
  maximumTotalFileBytes: number
}

export const SSH_DIRECTORY_TRANSFER_LIMITS: SshDirectoryTransferLimits = {
  maximumEntries: 4_096,
  maximumDepth: 64,
  maximumPathBytes: 16 * 1024,
  maximumRetainedPathBytes: 4 * 1024 * 1024,
  maximumFileBytes: 16 * 1024 * 1024,
  maximumTotalFileBytes: 32 * 1024 * 1024
}

// Why: folder DOWNLOAD streams each file straight to disk and only holds one directory's entry list
// in memory at a time, so its real cost is bounded by depth plus that directory's size — far below
// the whole-tree entry count. The limits above are sized for an in-memory upload package, and their
// 4,096-entry ceiling rejects an ordinary checkout containing node_modules. Downloads get a much
// higher whole-tree backstop while keeping the depth and per-path guards.
export const SSH_FOLDER_DOWNLOAD_LIMITS: SshDirectoryTransferLimits = {
  maximumEntries: 1_000_000,
  maximumDepth: 64,
  maximumPathBytes: 16 * 1024,
  maximumRetainedPathBytes: 256 * 1024 * 1024,
  maximumFileBytes: SSH_DIRECTORY_TRANSFER_LIMITS.maximumFileBytes,
  maximumTotalFileBytes: Number.MAX_SAFE_INTEGER
}

export const WINDOWS_SSH_UPLOAD_PACKAGE_MAX_BYTES = 48 * 1024 * 1024

export class SshDirectoryTransferCapacityError extends Error {
  constructor(
    readonly reason: 'entries' | 'depth' | 'path' | 'paths' | 'file' | 'files' | 'package'
  ) {
    super(`SSH directory transfer exceeds the ${reason} limit`)
    this.name = 'SshDirectoryTransferCapacityError'
  }
}

export class SshDirectoryTransferBudget {
  private entries = 0
  private retainedPathBytes = 0
  private totalFileBytes = 0

  constructor(private readonly limits = SSH_DIRECTORY_TRANSFER_LIMITS) {}

  recordPath(path: string, depth: number, options?: { countEntry?: boolean }): void {
    if (depth > this.limits.maximumDepth) {
      throw new SshDirectoryTransferCapacityError('depth')
    }
    if (options?.countEntry !== false) {
      this.entries += 1
      if (this.entries > this.limits.maximumEntries) {
        throw new SshDirectoryTransferCapacityError('entries')
      }
    }
    const pathBytes = Buffer.byteLength(path, 'utf8')
    if (pathBytes > this.limits.maximumPathBytes) {
      throw new SshDirectoryTransferCapacityError('path')
    }
    this.retainedPathBytes += pathBytes
    if (this.retainedPathBytes > this.limits.maximumRetainedPathBytes) {
      throw new SshDirectoryTransferCapacityError('paths')
    }
  }

  recordFile(fileBytes: number): void {
    if (fileBytes > this.limits.maximumFileBytes) {
      throw new SshDirectoryTransferCapacityError('file')
    }
    this.totalFileBytes += fileBytes
    if (this.totalFileBytes > this.limits.maximumTotalFileBytes) {
      throw new SshDirectoryTransferCapacityError('files')
    }
  }
}
