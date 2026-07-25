/**
 * Tracks which renderer (webContents) registered which pet surfaces, so a window
 * that is destroyed can have its surfaces evicted from the presence authority
 * immediately.
 *
 * Why it exists: a surface is normally retired by the renderer calling
 * removeSurface on unmount. A *closed* window — a popout especially — is torn
 * down before its renderer can run that cleanup, so the authority keeps the dead
 * surface as the pet's holder until the 30s stale sweep. That is the "pet lost
 * in limbo for ~30s, then reappears on the phone" bug. Evicting on webContents
 * destruction makes the handoff instant.
 *
 * Kept Electron-free (plain numeric ids) so the eviction bookkeeping is testable
 * without a live IPC layer.
 */
export class PetSurfaceOwnership {
  private readonly byWebContents = new Map<number, Set<string>>()

  /**
   * Record that `webContentsId` owns `surfaceId`. Returns true only the first
   * time a webContents is seen, so the caller can attach exactly one
   * `destroyed` listener per renderer.
   */
  add(webContentsId: number, surfaceId: string): boolean {
    const existing = this.byWebContents.get(webContentsId)
    if (existing) {
      existing.add(surfaceId)
      return false
    }
    this.byWebContents.set(webContentsId, new Set([surfaceId]))
    return true
  }

  /** Drop one surface (a clean removeSurface). */
  forget(webContentsId: number, surfaceId: string): void {
    const set = this.byWebContents.get(webContentsId)
    if (!set) {
      return
    }
    set.delete(surfaceId)
    if (set.size === 0) {
      this.byWebContents.delete(webContentsId)
    }
  }

  /**
   * Remove all of a destroyed renderer's surfaces and return them so the caller
   * can evict each from the authority. Idempotent: a second call (or a call
   * after a clean removeSurface already emptied it) returns nothing.
   */
  evictAll(webContentsId: number): string[] {
    const set = this.byWebContents.get(webContentsId)
    if (!set) {
      return []
    }
    this.byWebContents.delete(webContentsId)
    return [...set]
  }
}
