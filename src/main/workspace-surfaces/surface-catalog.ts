import { SurfaceSessionProjectionCache } from '../../shared/workspace-surfaces/surface-session-projection-cache'
import type { SurfaceKey, WorkspaceSurface } from '../../shared/workspace-surfaces/surface-content'
import type { WorkspaceSurfaceReader } from '../../shared/workspace-surfaces/surface-reader'
import type { SurfaceProfileDomain } from '../../shared/workspace-surfaces/surface-profile-domain'
import type {
  SurfaceHostSnapshot,
  SurfaceCommittedChanges
} from '../../shared/workspace-surfaces/surface-storage-command'
import { rowKey } from './surface-rows'
import { unresolvedSurfaceNativeSessionIds } from '../../shared/workspace-surfaces/surface-session-projection'
import { surfaceAdmissionRegistry } from './surface-admission-capture'

export type {
  SurfaceHostSnapshot,
  SurfaceCommittedChanges
} from '../../shared/workspace-surfaces/surface-storage-command'

/** A published mirror only; commands always decide again at the profile owner's transaction. */
export class SurfaceCatalog implements WorkspaceSurfaceReader {
  private readonly unresolved = new Map<string, ReadonlySet<string>>()
  private readonly dirtyRows = new Set<string>()
  private readonly projections = new Map<string, SurfaceSessionProjectionCache>()
  private readonly hosts = new Map<string, SurfaceHostSnapshot>()
  private readonly rows = new Map<string, Map<string, WorkspaceSurface>>()

  private readonly workspaces = new Map<string, Map<string, readonly WorkspaceSurface[]>>()
  private readonly aliases = new Map<string, Map<string, WorkspaceSurface>>()

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
    surfaceAdmissionRegistry(this).invalidate(
      copy.surfaces.filter((surface) => surface.content && !this.read(surface)?.content)
    )
    this.projections.set(hostId, new SurfaceSessionProjectionCache(copy.surfaces))
    this.unresolved.set(hostId, unresolvedSurfaceNativeSessionIds(copy.surfaces, copy.nativeTabs))
    this.hosts.set(hostId, copy)
    this.rows.set(hostId, new Map(copy.surfaces.map((surface) => [rowKey(surface), surface])))
    const workspaces = new Map<string, WorkspaceSurface[]>()
    const aliases = new Map<string, WorkspaceSurface>()
    for (const surface of copy.surfaces) {
      const group = workspaces.get(surface.workspaceId) ?? []
      group.push(surface)
      workspaces.set(surface.workspaceId, group)
      if (surface.content?.kind === 'terminal') {
        aliases.set(JSON.stringify([surface.workspaceId, surface.content.entityId]), surface)
      }
    }
    this.workspaces.set(hostId, workspaces)
    this.aliases.set(hostId, aliases)
  }

  adoptCommittedChanges(
    hostId: string,
    snapshot: SurfaceHostSnapshot,
    changes: SurfaceCommittedChanges
  ): void {
    const previous = this.hosts.get(hostId)
    if (!previous) {
      this.adoptCommittedHost(hostId, snapshot)
      return
    }
    if (previous.revision > snapshot.revision) {
      return
    }
    const rows = this.rows.get(hostId)!
    const affected = new Set<string>()
    for (const key of changes.removed) {
      rows.delete(rowKey(key))
      affected.add(key.workspaceId)
    }
    for (const surface of changes.upserted) {
      rows.set(rowKey(surface), structuredClone(surface))
      affected.add(surface.workspaceId)
    }
    this.rows.set(hostId, rows)
    const workspaces = this.workspaces.get(hostId)!
    const aliases = this.aliases.get(hostId)!
    for (const workspaceId of affected) {
      const before = workspaces.get(workspaceId) ?? []
      for (const row of before) {
        if (row.content?.kind === 'terminal') {
          aliases.delete(JSON.stringify([workspaceId, row.content.entityId]))
        }
      }
      const next = new Map(before.map((row) => [rowKey(row), row]))
      for (const key of changes.removed) {
        if (key.workspaceId === workspaceId) {
          next.delete(rowKey(key))
        }
      }
      for (const row of changes.upserted) {
        if (row.workspaceId === workspaceId) {
          next.set(rowKey(row), rows.get(rowKey(row))!)
        }
      }
      workspaces.set(workspaceId, [...next.values()])
      for (const row of next.values()) {
        if (row.content?.kind === 'terminal') {
          aliases.set(JSON.stringify([workspaceId, row.content.entityId]), row)
        }
      }
    }
    this.workspaces.set(hostId, workspaces)
    this.aliases.set(hostId, aliases)
    this.hosts.set(hostId, {
      ...previous,
      terminalInitialized: snapshot.terminalInitialized,
      chatInitialization: snapshot.chatInitialization,
      revision: snapshot.revision,
      nativeTabs: structuredClone(snapshot.nativeTabs)
    })
    if (affected.size) {
      this.dirtyRows.add(hostId)
      this.projections.set(
        hostId,
        new SurfaceSessionProjectionCache(this.all(hostId), this.projections.get(hostId))
      )
    }
    this.unresolved.set(
      hostId,
      unresolvedSurfaceNativeSessionIds(this.all(hostId), snapshot.nativeTabs)
    )
  }

  initialized(hostId: string): boolean {
    return this.hosts.get(hostId)?.terminalInitialized === true
  }

  revision(hostId: string): number {
    return this.hosts.get(hostId)?.revision ?? 0
  }

  hostIds(): readonly string[] {
    return [...this.hosts.keys()]
  }

  chatInitialized(hostId: string): boolean {
    return this.hosts.get(hostId)?.chatInitialization === 'verified'
  }

  unresolvedNativeSessionIds(hostId: string): ReadonlySet<string> {
    return this.unresolved.get(hostId) ?? new Set()
  }

  read(key: SurfaceKey): WorkspaceSurface | null {
    return this.rows.get(key.hostId)?.get(rowKey(key)) ?? null
  }

  projectionCache(hostId: string): SurfaceSessionProjectionCache | undefined {
    return this.projections.get(hostId)
  }

  workspace(hostId: string, workspaceId: string): readonly WorkspaceSurface[] {
    return this.workspaces.get(hostId)?.get(workspaceId) ?? []
  }

  terminal(key: SurfaceKey): WorkspaceSurface | null {
    const exact = this.read(key)
    return exact?.content?.kind === 'terminal'
      ? exact
      : (this.aliases.get(key.hostId)?.get(rowKey(key)) ?? null)
  }

  all(hostId: string): readonly WorkspaceSurface[] {
    const host = this.hosts.get(hostId)
    if (host && this.dirtyRows.delete(hostId)) {
      host.surfaces = [...(this.rows.get(hostId)?.values() ?? [])]
    }
    return host?.surfaces ?? []
  }
}
