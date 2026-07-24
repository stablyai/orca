export type LocalDownloadedFolderPromotionLimits = {
  maximumEntries: number
  maximumDepth: number
  maximumPathBytes: number
  maximumRetainedPathBytes: number
}

export const LOCAL_DOWNLOADED_FOLDER_PROMOTION_LIMITS: LocalDownloadedFolderPromotionLimits = {
  maximumEntries: 50_000,
  maximumDepth: 64,
  maximumPathBytes: 64 * 1024,
  maximumRetainedPathBytes: 16 * 1024 * 1024
}

export class LocalDownloadedFolderPromotionCapacityError extends Error {
  constructor(readonly reason: 'entries' | 'depth' | 'path' | 'paths') {
    super(`Downloaded folder promotion exceeds the ${reason} limit`)
    this.name = 'LocalDownloadedFolderPromotionCapacityError'
  }
}

export class LocalDownloadedFolderPromotionBudget {
  private entries = 0
  private retainedPathBytes = 0

  constructor(private readonly limits = LOCAL_DOWNLOADED_FOLDER_PROMOTION_LIMITS) {}

  recordEntry(sourcePath: string, destinationPath: string, depth: number): void {
    if (depth > this.limits.maximumDepth) {
      throw new LocalDownloadedFolderPromotionCapacityError('depth')
    }
    this.entries += 1
    if (this.entries > this.limits.maximumEntries) {
      throw new LocalDownloadedFolderPromotionCapacityError('entries')
    }
    const sourceBytes = Buffer.byteLength(sourcePath, 'utf8')
    const destinationBytes = Buffer.byteLength(destinationPath, 'utf8')
    if (
      sourceBytes > this.limits.maximumPathBytes ||
      destinationBytes > this.limits.maximumPathBytes
    ) {
      throw new LocalDownloadedFolderPromotionCapacityError('path')
    }
    this.retainedPathBytes += sourceBytes + destinationBytes
    if (this.retainedPathBytes > this.limits.maximumRetainedPathBytes) {
      throw new LocalDownloadedFolderPromotionCapacityError('paths')
    }
  }
}
