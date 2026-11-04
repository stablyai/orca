import type { SurfaceKey, WorkspaceSurface } from '../../shared/workspace-surfaces/surface-content'
import type { WorkspaceSurfaceReader } from '../../shared/workspace-surfaces/surface-reader'
import type { SurfaceProfileDomain } from '../../shared/workspace-surfaces/surface-profile-domain'
import type { SurfaceHostSnapshot } from '../../shared/workspace-surfaces/surface-storage-command'
import { rowKey } from './surface-rows'
import { unresolvedSurfaceNativeSessionIds } from '../../shared/workspace-surfaces/surface-session-projection'

export type { SurfaceHostSnapshot } from '../../shared/workspace-surfaces/surface-storage-command'

/** A published mirror only; commands always decide again at the profile owner's transaction. */
export class SurfaceCatalog implements WorkspaceSurfaceReader {
  private readonly hosts = new Map<string, SurfaceHostSnapshot>()
  private readonly rows = new Map<string, ReadonlyMap<string, WorkspaceSurface>>()

  constructor(domain: SurfaceProfileDomain) {
    for (const [hostId, host] of Object.entries(domain.hosts)) {
      this.adoptCommittedHost(hostId, { ...host, nativeTabs: host.chatBaseline?.tabs })
    }
  }

  adoptCommittedHost(hostId: string, snapshot: SurfaceHostSnapshot): void {
    if ((this.hosts.get(hostId)?.revision ?? -1) > snapshot.revision) {
      return
    }
    const copy = structuredClone({
      terminalInitialized: snapshot.terminalInitialized,
      chatInitialization: snapshot.chatInitialization,
      revision: snapshot.revision,
      surfaces: snapshot.surfaces,
      nativeTabs: snapshot.nativeTabs
    })
    this.hosts.set(hostId, copy)
    this.rows.set(hostId, new Map(copy.surfaces.map((surface) => [rowKey(surface), surface])))
  }

  initialized(hostId: string): boolean {
    return this.hosts.get(hostId)?.terminalInitialized === true
  }

  hostIds(): readonly string[] {
    return [...this.hosts.keys()]
  }

  chatInitialized(hostId: string): boolean {
    return this.hosts.get(hostId)?.chatInitialization === 'verified'
  }

  unresolvedNativeSessionIds(hostId: string): ReadonlySet<string> {
    const host = this.hosts.get(hostId)
    return unresolvedSurfaceNativeSessionIds(host?.surfaces ?? [], host?.nativeTabs)
  }

  read(key: SurfaceKey): WorkspaceSurface | null {
    return this.rows.get(key.hostId)?.get(rowKey(key)) ?? null
  }

  all(hostId: string): readonly WorkspaceSurface[] {
    return this.hosts.get(hostId)?.surfaces ?? []
  }
}
