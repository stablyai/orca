import { randomUUID } from 'node:crypto'
import type { WorkspaceLayoutModel } from '../../shared/workspace-layout/workspace-layout-model'
import type Database from '../sqlite/sync-database'
import type { WorkspaceSurfaceDatabase } from './surface-database'
import type { SurfaceKey, WorkspaceSurface } from '../../shared/workspace-surfaces/surface-content'
import type {
  SurfaceCommandIdentity,
  SurfaceCommandOutcome,
  SurfaceContentReplacement,
  SurfaceMoveRequest,
  SurfaceLayoutRequest,
  SurfaceLayoutView
} from '../../shared/workspace-surfaces/surface-command'
import { workspaceSurfaceSchema } from '../../shared/workspace-surfaces/surface-schema'
import { SurfaceRunRepository } from './surface-run-repository'
import { seedSurfaceProjectionBaseline } from './surface-legacy-projection'
import { readSurface, readWorkspace, writeSurface } from './surface-rows'
import { applySurfaceLayout } from './surface-layout-command'
import { moveSurfaceContent, replaceSurfaceContent } from './surface-content-command'
import { runSurfaceCommand } from './surface-command-receipts'
import { recordSurfaceHost } from './surface-transaction-changes'

/** Every decision reads the shared transaction; there is no independent content cache or queue. */
export class WorkspaceSurfaceRepository {
  readonly runs: SurfaceRunRepository

  constructor(
    private readonly storage: WorkspaceSurfaceDatabase,
    private readonly mintId: () => string = randomUUID,
    private readonly now: () => number = Date.now
  ) {
    this.runs = new SurfaceRunRepository(storage)
  }

  initialized(hostId: string): boolean {
    return (
      this.storage.db
        .prepare('SELECT initialized FROM main.workspace_surface_domains WHERE host_id = ?')
        .get(hostId)?.initialized === 1
    )
  }

  read(key: SurfaceKey): WorkspaceSurface | null {
    return readSurface(this.storage.db, key)
  }

  list(hostId: string, workspaceId: string): WorkspaceSurface[] {
    return readWorkspace(this.storage.db, hostId, workspaceId)
  }

  all(hostId: string): WorkspaceSurface[] {
    return this.storage.db
      .prepare('SELECT row_json FROM main.workspace_surfaces WHERE host_id = ? ORDER BY rowid')
      .all(hostId)
      .map((row) => workspaceSurfaceSchema.parse(JSON.parse(String(row.row_json))))
  }

  workspaces(hostId: string): string[] {
    return this.storage.db
      .prepare(`SELECT workspace_id FROM main.workspace_surfaces WHERE host_id = ?
      UNION SELECT workspace_id FROM main.workspace_surface_projections WHERE host_id = ?`)
      .all(hostId, hostId)
      .map((row) => String(row.workspace_id))
  }

  /** An empty seed commits authority too; legacy exports must never reimport on ordinary startup. */
  initialize(
    hostId: string,
    surfaces: readonly WorkspaceSurface[],
    workspaceIds: readonly string[] = []
  ): void {
    this.writable()
    this.storage.transaction((db) => {
      const host = db
        .prepare(
          'SELECT initialized, revision FROM main.workspace_surface_domains WHERE host_id = ?'
        )
        .get(hostId)
      if (host?.initialized === 1) {
        return
      }
      for (const seed of surfaces) {
        const surface = workspaceSurfaceSchema.parse(seed)
        if (surface.hostId !== hostId || readSurface(db, surface) !== null) {
          throw new Error('surface_seed_identity_conflict')
        }
        writeSurface(db, surface)
      }
      const revision = Number(host?.revision ?? 0) + 1
      db.prepare(
        `INSERT INTO main.workspace_surface_domains(host_id, initialized, revision) VALUES (?, 1, ?)
        ON CONFLICT(host_id) DO UPDATE SET initialized = 1, revision = excluded.revision`
      ).run(hostId, revision)
      recordSurfaceHost(db, hostId, true, revision)
      for (const workspaceId of new Set([
        ...workspaceIds,
        ...surfaces.map((surface) => surface.workspaceId)
      ])) {
        seedSurfaceProjectionBaseline(
          db,
          hostId,
          workspaceId,
          surfaces.filter((surface) => surface.workspaceId === workspaceId),
          this.mintId
        )
      }
    })
  }

  applyLayout(
    request: SurfaceLayoutRequest,
    view: SurfaceLayoutView,
    present?: (model: WorkspaceLayoutModel) => void,
    rawClosed?: (tabId: string, workspaceId: string) => boolean
  ): SurfaceCommandOutcome {
    let model: WorkspaceLayoutModel | undefined
    const outcome = this.command(request, request, (db) =>
      applySurfaceLayout(
        db,
        request,
        view,
        this.mintId,
        (next) => {
          model = next
        },
        rawClosed
      )
    )
    if (outcome.status === 'accepted' && model) {
      present?.(model)
    }
    return outcome
  }

  replaceContent(request: SurfaceContentReplacement, applied?: () => void): SurfaceCommandOutcome {
    return this.command(request, request, (db) => {
      const outcome = replaceSurfaceContent(db, request, this.mintId, this.now)
      if (outcome.status === 'accepted') {
        applied?.()
      }
      return outcome
    })
  }

  move(request: SurfaceMoveRequest): SurfaceCommandOutcome {
    return this.command(request, request, (db) => moveSurfaceContent(db, request, this.mintId))
  }

  private writable(): void {
    if (this.storage.readOnly) {
      throw new Error('surface_store_read_only')
    }
  }

  private command(
    identity: SurfaceCommandIdentity,
    input: unknown,
    apply: (db: Database.Database) => SurfaceCommandOutcome
  ): SurfaceCommandOutcome {
    this.writable()
    return this.storage.transaction((db) =>
      runSurfaceCommand(db, identity, input, this.now, () => apply(db))
    )
  }
}
