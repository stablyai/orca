// Startup reclamation of orphan plan-artifact files (Phase 5).
//
// A plan artifact is written to disk and committed to SQLite in two separate
// commit domains (see audited-plan-artifact-store.ts). A crash — or a lost
// ownership race in attachPlanArtifact — between the atomic rename and the DB
// commit leaves a final artifact file with no row. This sweep reclaims exactly
// those, and NOTHING else.
//
// CONSERVATIVE BY CONSTRUCTION: it deletes only what it can prove is
// unreferenced. A directory whose name could not have come from
// generatePlanArtifactId, or one whose row exists in ANY status (including
// 'superseded', which is retained audit history), is left strictly alone.
// Deleting a referenced artifact would destroy the body behind a durable row.
import { readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type Database from '../sqlite/sync-database'
import { listPlanArtifactIds, PLAN_ARTIFACT_ID_PATTERN } from './audited-plan-artifact-repository'

export type PlanArtifactGcResult = {
  removedDirectories: number
  removedTempFiles: number
}

function getPlansRoot(userDataPath: string): string {
  return join(userDataPath, 'audited-workflow', 'plans')
}

/**
 * Removes orphan artifact directories and leftover temp files.
 *
 * Returns counters rather than paths — a caller that logged a returned path
 * could leak it, and nothing needs them. Never throws: the caller runs during
 * IPC handler registration.
 */
export function reconcilePlanArtifactFiles(
  db: Database.Database,
  userDataPath: string
): PlanArtifactGcResult {
  const root = getPlansRoot(userDataPath)
  const result: PlanArtifactGcResult = { removedDirectories: 0, removedTempFiles: 0 }

  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    // No plans directory yet (or unreadable) — nothing to reclaim.
    return result
  }

  const known = listPlanArtifactIds(db)

  for (const entry of entries) {
    const entryPath = join(root, entry)
    try {
      if (!statSync(entryPath).isDirectory()) {
        continue
      }
    } catch {
      continue
    }

    // A directory name that generatePlanArtifactId could never have produced is
    // not ours to delete, whatever it is.
    if (!PLAN_ARTIFACT_ID_PATTERN.test(entry)) {
      continue
    }

    if (known.has(entry)) {
      // Referenced in ANY status. Sweep only the stray temp file inside it — a
      // crash mid-write can leave one beside a perfectly good committed artifact.
      result.removedTempFiles += removeTempFile(entryPath)
      continue
    }

    try {
      rmSync(entryPath, { recursive: true, force: true })
      result.removedDirectories += 1
    } catch (error) {
      console.error('[auditedWorkflow] Removing an orphan plan artifact failed:', error)
    }
  }

  return result
}

function removeTempFile(directory: string): number {
  try {
    rmSync(join(directory, '.plan.md.tmp'), { force: true })
    return 1
  } catch {
    return 0
  }
}

/**
 * Fail-safe wrapper for startup. Runs during IPC handler registration, where an
 * exception would abort registration and leave the app with no handlers at all.
 * A failed sweep only means orphans persist until the next start — nothing
 * depends on them being gone.
 */
export function reconcilePlanArtifactFilesOnStartup(
  db: Database.Database,
  userDataPath: string
): void {
  try {
    reconcilePlanArtifactFiles(db, userDataPath)
  } catch (error) {
    console.error('[auditedWorkflow] Plan artifact reconciliation failed:', error)
  }
}
