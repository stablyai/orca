/**
 * Each WSL bridge pane remembers its distro's boot id from its spawn, so an exit the running list
 * calls 'running' can still be told apart as the distro having been terminated and booted again.
 * Reads go through the background-work gate (E9): only into a distro a fresh list says is running.
 */
import {
  isWslDistroRunningForBackgroundWork,
  noteWslDistroMayHaveStopped
} from '../wsl-background-distro-gate'
import { onRunningWslDistrosStopped } from '../wsl-running-distro-cache'
import { readWslDistroBootId } from '../wsl/wsl-distro-boot-id'

export type WslBridgeBootIdentityDeps = {
  isRunning: (distro: string) => Promise<boolean>
  /** Null when the id could not be read. */
  readBootId: (distro: string) => Promise<string | null>
  /** Confirmed running lists that no longer name a distro; returns an unsubscribe. */
  onDistrosStopped?: (listener: (stopped: string[]) => void) => () => void
  /** A bridge exit may be its distro stopping: later background reads must start after it settles. */
  noteMayHaveStopped?: (distro: string) => void
}

export const PRODUCTION_WSL_BRIDGE_BOOT_IDENTITY_DEPS: WslBridgeBootIdentityDeps = {
  isRunning: isWslDistroRunningForBackgroundWork,
  readBootId: readWslDistroBootId,
  onDistrosStopped: onRunningWslDistrosStopped,
  noteMayHaveStopped: noteWslDistroMayHaveStopped
}

function distroKey(distro: string): string {
  return distro.trim().toLowerCase()
}

export class WslBridgeBootIdentity {
  // One read per distro boot, reused by later spawns; any bridge exit of the distro drops it.
  private readonly byDistro = new Map<string, Promise<string | null>>()
  // A burst of exits (a terminate exits every pane) shares one read of the current id.
  private readonly currentReads = new Map<string, Promise<string | null>>()
  private readonly bySession = new Map<
    string,
    { distro: string; incarnationId: string | undefined; bootId: Promise<string | null> }
  >()

  // Held only while a bridge pane lives, so an idle adapter keeps no listener.
  private unsubscribeStops: (() => void) | null = null

  constructor(
    private readonly deps: WslBridgeBootIdentityDeps = PRODUCTION_WSL_BRIDGE_BOOT_IDENTITY_DEPS
  ) {}

  /** A spawn or reattach of `sessionId`; a new incarnation takes the distro's current boot id. */
  noteSpawn(sessionId: string, distro: string, incarnationId?: string): void {
    const key = distroKey(distro)
    const current = this.bySession.get(sessionId)
    if (
      current?.distro === key &&
      incarnationId !== undefined &&
      current.incarnationId === incarnationId
    ) {
      return
    }
    // A stop seen before the exit reaches us: a pane spawned meanwhile must not take the old id.
    this.unsubscribeStops ??=
      this.deps.onDistrosStopped?.((stopped) => stopped.forEach((name) => this.dropBootId(name))) ??
      null
    this.bySession.set(sessionId, { distro: key, incarnationId, bootId: this.distroBootId(distro) })
  }

  /**
   * Synchronous, as the exit arrives: it may be the first of a reboot's, so a spawn during its
   * verdict must not inherit the old boot's id. It may also be the distro stopping (E9): until that
   * settles, a stopping distro WSL still lists must not pass the gate into a boot-id exec.
   */
  noteExit(distro: string): void {
    this.deps.noteMayHaveStopped?.(distro)
    this.dropBootId(distro)
  }

  private dropBootId(distro: string): void {
    this.byDistro.delete(distroKey(distro))
  }

  /**
   * An exit of an incarnation the session already replaced: the respawn that beat it took the
   * cached id, which may be the old boot's, so the current incarnation reads it again.
   */
  noteStaleExit(sessionId: string, distro: string): void {
    this.noteExit(distro)
    const current = this.bySession.get(sessionId)
    if (current?.distro === distroKey(distro)) {
      current.bootId = this.distroBootId(distro)
    }
  }

  /** After a bridge exit the running list answered 'running': has the distro booted again since? */
  async rebootedSinceSpawn(sessionId: string, distro: string): Promise<boolean> {
    const spawned = this.bySession.get(sessionId)
    if (!spawned) {
      return false
    }
    const [before, now] = await Promise.all([spawned.bootId, this.readCurrent(distro)])
    // An unreadable id on either side proves nothing: the exit stays an exit.
    return before !== null && now !== null && before !== now
  }

  forget(sessionId: string): void {
    const spawned = this.bySession.get(sessionId)
    this.bySession.delete(sessionId)
    if (spawned && ![...this.bySession.values()].some(({ distro }) => distro === spawned.distro)) {
      this.byDistro.delete(spawned.distro)
    }
    if (this.bySession.size === 0) {
      this.unsubscribeStops?.()
      this.unsubscribeStops = null
    }
  }

  private distroBootId(distro: string): Promise<string | null> {
    const key = distroKey(distro)
    let bootId = this.byDistro.get(key)
    if (!bootId) {
      bootId = this.read(distro)
      this.byDistro.set(key, bootId)
    }
    return bootId
  }

  private readCurrent(distro: string): Promise<string | null> {
    const key = distroKey(distro)
    let reading = this.currentReads.get(key)
    if (!reading) {
      reading = this.read(distro).finally(() => this.currentReads.delete(key))
      this.currentReads.set(key, reading)
    }
    return reading
  }

  private async read(distro: string): Promise<string | null> {
    try {
      return (await this.deps.isRunning(distro)) ? await this.deps.readBootId(distro) : null
    } catch {
      return null
    }
  }
}
