// Integrator wiring (Unit 8, finding #6 of the critical review): a shared observable over
// paired host profiles so the phone settings page and the app shell can both react to
// pairing/removal without depending on each other. Previously the shell only loaded profiles
// once at boot and the phone page only re-rendered its own DOM, so pairing a host after startup
// never connected the shell, and removing the active host's profile never tore down its
// session. Both consumers now share one ProfileController instance (wired in main.ts).
import type { GlassesHostProfile } from '../state/hud-store'

export type HostProfilePort = {
  load(): Promise<GlassesHostProfile[]>
  upsert(profile: GlassesHostProfile): Promise<void>
  remove(id: string): Promise<void>
}

export type ProfileChangeEvent =
  | { type: 'upserted'; profile: GlassesHostProfile }
  | { type: 'removed'; id: string }

/** Wraps a HostProfilePort, broadcasting every upsert/remove to subscribers (finding #6). */
export class ProfileController implements HostProfilePort {
  private readonly listeners = new Set<(event: ProfileChangeEvent) => void>()

  constructor(private readonly store: HostProfilePort) {}

  load(): Promise<GlassesHostProfile[]> {
    return this.store.load()
  }

  async upsert(profile: GlassesHostProfile): Promise<void> {
    await this.store.upsert(profile)
    this.emit({ type: 'upserted', profile })
  }

  async remove(id: string): Promise<void> {
    await this.store.remove(id)
    this.emit({ type: 'removed', id })
  }

  subscribe(listener: (event: ProfileChangeEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(event: ProfileChangeEvent): void {
    for (const listener of this.listeners) {
      listener(event)
    }
  }
}
