import { PROFILE_STATE_META_PROFILE_ID } from '../persistence/profile-state/profile-state-database-schema'
import { isDeepStrictEqual } from 'node:util'
import { statSync } from 'node:fs'
import type Database from '../sqlite/sync-database'
import { openProfileStateDatabaseReadOnly } from '../persistence/profile-state/profile-state-database'
import { withProfileStateReadSnapshot } from '../persistence/profile-state/profile-state-read-snapshot'
import { readSurfaceProfileSnapshot } from './surface-profile-cache'
import { runLeafOf, runTargetOf } from '../../shared/workspace-surfaces/surface-allocation'
import type {
  SurfaceExecutorAdmission,
  SurfaceExecutorIntent
} from '../../shared/workspace-surfaces/surface-executor-contract'

/** Executor workers read the same carrier; missing or damaged storage never authorizes a fork. */
export function readSurfaceExecutorIntent(
  admission: SurfaceExecutorAdmission
): SurfaceExecutorIntent {
  const reader = new SurfaceExecutorIntentReader()
  try {
    return reader.read(admission)
  } finally {
    reader.close()
  }
}

/** One read-worker lifetime, one current carrier handle; replacement never reuses an old inode. */
export class SurfaceExecutorIntentReader {
  private current:
    | { databasePath: string; profileId: string; identity: string; db: Database.Database }
    | undefined

  close(): void {
    this.current?.db.close()
    this.current = undefined
  }

  read(admission: SurfaceExecutorAdmission): SurfaceExecutorIntent {
    try {
      const { databasePath, profileId } = admission.scope
      const identity = fileIdentity(databasePath)
      if (
        this.current?.databasePath !== databasePath ||
        this.current.profileId !== profileId ||
        this.current.identity !== identity
      ) {
        this.close()
        this.current = {
          databasePath,
          profileId,
          identity,
          db: openProfileStateDatabaseReadOnly(databasePath, profileId).db
        }
      }
      const result = withProfileStateReadSnapshot(this.current.db, () =>
        readIntent(this.current!.db, admission)
      )
      if (fileIdentity(databasePath) !== identity) {
        this.close()
        return { kind: 'unreadable' }
      }
      return result
    } catch {
      this.close()
      return { kind: 'unreadable' }
    }
  }
}

function fileIdentity(path: string): string {
  const stat = statSync(path, { bigint: true })
  return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`
}

function readIntent(
  db: Database.Database,
  admission: SurfaceExecutorAdmission
): SurfaceExecutorIntent {
  if (
    db
      .prepare('SELECT value FROM main.profile_state_meta WHERE key = ?')
      .get(PROFILE_STATE_META_PROFILE_ID)?.value !== admission.scope.profileId
  ) {
    return { kind: 'unreadable' }
  }
  const root = readSurfaceProfileSnapshot(db)
  const host = root.domain.hosts[admission.hostId]
  if (!host?.terminalInitialized) {
    return { kind: 'unreadable' }
  }
  const index = root.hosts.get(admission.hostId)!
  const allocation = index.allocations.get(admission.allocationId)
  if (allocation) {
    if (
      allocation.resourceId !== admission.resourceId ||
      allocation.executorId !== admission.executorId ||
      !isDeepStrictEqual(allocation.provenance ?? null, admission.provenance ?? null) ||
      allocation.target.runId !== allocation.allocationId ||
      allocation.target.hostId !== admission.hostId
    ) {
      return { kind: 'unreadable' }
    }
    if (allocation.decision === 'pending') {
      const surface = index.surfaces.get(
        JSON.stringify([allocation.target.workspaceId, allocation.target.hostTabId])
      )
      if (!surface || !runLeafOf(surface, allocation.target)) {
        return { kind: 'unreadable' }
      }
    }
    return { kind: 'allocation', allocation }
  }
  const bound = index.runs.get(admission.allocationId)
  if (bound?.surface.content?.kind === 'terminal') {
    const { surface, leafId } = bound
    const leaf = bound.surface.content.leaves[leafId]!
    if (
      leaf.executorId === admission.executorId &&
      isDeepStrictEqual(leaf.provenance ?? null, admission.provenance ?? null) &&
      leaf.facts.ptyId === admission.resourceId
    ) {
      return {
        kind: 'bound',
        target: runTargetOf(surface, leafId)!,
        resource: {
          ptyId: admission.resourceId,
          ...(leaf.facts.incarnationId ? { incarnationId: leaf.facts.incarnationId } : {})
        }
      }
    }
  }
  return { kind: 'absent' }
}
