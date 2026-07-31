import type { DaemonPtyAdapter } from './daemon-pty-adapter'

export class DaemonSessionOwnerResolutionCache {
  private readonly pending = new Map<string, Promise<DaemonPtyAdapter>>()

  async resolve(
    sessionId: string,
    start: () => Promise<DaemonPtyAdapter>
  ): Promise<DaemonPtyAdapter> {
    const existing = this.pending.get(sessionId)
    if (existing) {
      return await existing
    }
    const resolution = start()
    this.pending.set(sessionId, resolution)
    try {
      return await resolution
    } finally {
      if (this.pending.get(sessionId) === resolution) {
        this.pending.delete(sessionId)
      }
    }
  }
}
