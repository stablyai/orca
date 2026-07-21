import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import { getCanonicalUserDataPath } from '../persistence'
import {
  applyEdgeExit,
  applyPetIdentity,
  acknowledgeEntry,
  initialPresence,
  isSurfaceAlive,
  reconcileSurfaces,
  SURFACE_STALE_AFTER_MS,
  type PetEdge,
  type PetPoint,
  type PetPresence,
  type PetPresenceSnapshot,
  type PetSurface,
  type PetSurfaceKind
} from '../../shared/pet-presence'

/**
 * The single writer for pet presence (P1 of the cross-surface handoff plan).
 *
 * The pet is exclusive — one surface holds it at a time — and that can only be
 * true if exactly one process decides who. This module is that process. Desktop
 * renderers, popout windows and phones are all clients: they register a surface,
 * heartbeat it, report edge exits, and read state. None of them writes position.
 *
 * Deliberately a module-level singleton rather than something hung off the
 * runtime: one main process is one authority, and making that structural means
 * a second writer cannot be introduced by accident.
 *
 * All decision logic lives in shared/pet-presence.ts so the rules are pure and
 * unit-tested; this file only owns lifetime, persistence and notification.
 */

/** How often stale surfaces are swept. Comfortably under SURFACE_STALE_AFTER_MS
 *  so a dead surface is noticed well before a full stale window has passed. */
const RECONCILE_INTERVAL_MS = 5_000

type PresenceListener = (snapshot: PetPresenceSnapshot) => void

function storePath(): string {
  return join(getCanonicalUserDataPath(), 'pet', 'presence.json')
}

class PetPresenceAuthority {
  private presence: PetPresence = initialPresence(Date.now())
  private readonly surfaces = new Map<string, PetSurface>()
  private readonly listeners = new Set<PresenceListener>()
  private reconcileTimer: NodeJS.Timeout | null = null
  private loaded = false

  /**
   * Restore the last known position from disk. Surfaces are deliberately NOT
   * restored — a surface is a live window or phone, and one that existed before
   * a restart does not exist now. Position survives so the pet reappears where
   * the operator left it instead of snapping to centre on every launch.
   */
  private load(): void {
    if (this.loaded) {
      return
    }
    this.loaded = true
    try {
      const path = storePath()
      if (!existsSync(path)) {
        return
      }
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { presence?: Partial<PetPresence> }
      const stored = parsed.presence
      if (!stored || typeof stored !== 'object') {
        return
      }
      this.presence = {
        ...initialPresence(Date.now()),
        position: {
          x: typeof stored.position?.x === 'number' ? stored.position.x : 0.5,
          y: typeof stored.position?.y === 'number' ? stored.position.y : 0.5
        },
        facing: stored.facing === 'left' ? 'left' : 'right',
        // Why petId IS restored while surfaceId is not: identity outlives a
        // restart (it is the operator's choice of creature), whereas a surface
        // is a live window that no longer exists.
        petId: typeof stored.petId === 'string' ? stored.petId : null,
        // Why surfaceId is dropped: it names a window that no longer exists.
        // reconcileSurfaces adopts a live surface as soon as one registers.
        surfaceId: null
      }
    } catch {
      // A corrupt or unreadable store must not stop the app from having a pet.
    }
  }

  private persist(): void {
    try {
      const path = storePath()
      mkdirSync(dirname(path), { recursive: true })
      writeFileAtomically(path, `${JSON.stringify({ presence: this.presence }, null, 2)}\n`)
    } catch {
      // Losing persistence costs the pet's position across a restart, which is
      // not worth surfacing an error to the operator over.
    }
  }

  private snapshot(): PetPresenceSnapshot {
    return { presence: this.presence, surfaces: [...this.surfaces.values()] }
  }

  private emit(): void {
    const snapshot = this.snapshot()
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch {
        // One bad subscriber must not stop the others from being told.
      }
    }
  }

  /** Applies a presence transition, persisting and notifying only when it
   *  actually changed. The pure helpers return their input by identity on a
   *  no-op, which makes this comparison exact rather than a deep diff. */
  private commit(next: PetPresence): boolean {
    if (next === this.presence) {
      return false
    }
    this.presence = next
    this.persist()
    this.emit()
    return true
  }

  private ensureTimer(): void {
    if (this.reconcileTimer || this.surfaces.size === 0) {
      return
    }
    this.reconcileTimer = setInterval(() => this.reconcile(), RECONCILE_INTERVAL_MS)
    // Why unref: this timer must never be the reason the process stays alive.
    this.reconcileTimer.unref?.()
  }

  private stopTimerWhenIdle(): void {
    if (this.surfaces.size > 0 || !this.reconcileTimer) {
      return
    }
    clearInterval(this.reconcileTimer)
    this.reconcileTimer = null
  }

  private reconcile(): void {
    const now = Date.now()
    let removed = false
    for (const [id, surface] of this.surfaces) {
      if (!isSurfaceAlive(surface, now)) {
        this.surfaces.delete(id)
        removed = true
      }
    }
    const changed = this.commit(reconcileSurfaces(this.presence, [...this.surfaces.values()], now))
    if (removed && !changed) {
      // The roster changed even though the holder did not — clients render the
      // surface list, so they still need telling.
      this.emit()
    }
    this.stopTimerWhenIdle()
  }

  getState(): PetPresenceSnapshot {
    this.load()
    return this.snapshot()
  }

  /** Register or heartbeat a surface. Clients call this on mount and on a timer;
   *  a surface that stops calling is swept by reconcile(). */
  registerSurface(
    id: string,
    kind: PetSurfaceKind,
    /** Pet ids this surface can draw; null (the desktop case) means anything. */
    renderablePetIds: string[] | null = null
  ): PetPresenceSnapshot {
    this.load()
    const now = Date.now()
    const isNew = !this.surfaces.has(id)
    this.surfaces.set(id, { id, kind, seenAt: now, renderablePetIds })
    this.ensureTimer()
    const changed = this.commit(
      reconcileSurfaces(this.presence, [...this.surfaces.values()], now)
    )
    if (isNew && !changed) {
      this.emit()
    }
    return this.snapshot()
  }

  removeSurface(id: string): void {
    if (!this.surfaces.delete(id)) {
      return
    }
    const now = Date.now()
    if (!this.commit(reconcileSurfaces(this.presence, [...this.surfaces.values()], now))) {
      this.emit()
    }
    this.stopTimerWhenIdle()
  }

  /**
   * A surface reports the pet walked off one of its edges. Ignored unless that
   * surface actually holds the pet — the exclusivity guard lives in
   * applyEdgeExit and is unit-tested there.
   *
   * Returns the snapshot either way so a rejected caller re-syncs to the truth
   * instead of continuing to draw a pet it no longer owns.
   */
  reportExit(surfaceId: string, edge: PetEdge, position: PetPoint): PetPresenceSnapshot {
    this.load()
    const now = Date.now()
    this.commit(
      applyEdgeExit(this.presence, [...this.surfaces.values()], {
        fromSurfaceId: surfaceId,
        edge,
        position,
        now
      })
    )
    return this.snapshot()
  }

  /**
   * Record which pet the operator has selected, so identity travels with the
   * pet instead of each surface guessing. Called by desktop surfaces, which own
   * that selection; a phone mirrors what it is told.
   */
  setPetId(petId: string): PetPresenceSnapshot {
    this.load()
    this.commit(applyPetIdentity(this.presence, petId, Date.now()))
    return this.snapshot()
  }

  /** The receiving surface confirms it has played the arrival, so the entry
   *  marker can be cleared and the animation not replayed. */
  acknowledgeEntry(surfaceId: string): PetPresenceSnapshot {
    this.load()
    this.commit(acknowledgeEntry(this.presence, surfaceId, Date.now()))
    return this.snapshot()
  }

  /**
   * Force the pet onto a surface — the "come here" affordance, and the recovery
   * path when a pet is somewhere the operator cannot see. Only honoured for a
   * live surface, so a stale client cannot summon the pet into a dead window.
   */
  claim(surfaceId: string): PetPresenceSnapshot {
    this.load()
    const now = Date.now()
    const surface = this.surfaces.get(surfaceId)
    if (!surface || !isSurfaceAlive(surface, now)) {
      return this.snapshot()
    }
    if (this.presence.surfaceId !== surfaceId) {
      this.commit({ ...this.presence, surfaceId, enteredFromEdge: null, updatedAt: now })
    }
    return this.snapshot()
  }

  subscribe(listener: PresenceListener): () => void {
    this.load()
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Test seam: drop all state so one test cannot leak into the next. */
  resetForTests(): void {
    this.presence = initialPresence(Date.now())
    this.surfaces.clear()
    this.listeners.clear()
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer)
      this.reconcileTimer = null
    }
    this.loaded = true
  }
}

export const petPresenceAuthority = new PetPresenceAuthority()
export { SURFACE_STALE_AFTER_MS }
export type { PetPresenceSnapshot }
