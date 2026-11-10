import { rm } from 'node:fs/promises'

export class SkillUploadRetainedPaths {
  private readonly transferred = new Set<string>()
  private readonly failedCleanup = new Set<string>()

  get failedCleanupCount(): number {
    return this.failedCleanup.size
  }

  get isEmpty(): boolean {
    return this.transferred.size === 0 && this.failedCleanup.size === 0
  }

  retainTransferred(path: string): void {
    this.transferred.add(path)
  }

  retainFailedCleanup(path: string): void {
    this.failedCleanup.add(path)
  }

  async removeUnpublished(path: string, close: () => Promise<void>): Promise<void> {
    this.retainFailedCleanup(path)
    await close().catch(() => undefined)
    await this.removeFailedCleanup(path).catch(() => undefined)
  }

  async removeTransferred(path: string): Promise<void> {
    await rm(path, { force: true })
    this.transferred.delete(path)
  }

  async removeFailedCleanup(path: string): Promise<void> {
    await rm(path, { force: true })
    this.failedCleanup.delete(path)
  }

  async removeAllFailedCleanup(): Promise<void> {
    await Promise.all([...this.failedCleanup].map((path) => this.removeFailedCleanup(path)))
  }

  async retryFailedCleanup(): Promise<void> {
    await Promise.allSettled([...this.failedCleanup].map((path) => this.removeFailedCleanup(path)))
  }
}
