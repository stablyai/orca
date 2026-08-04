// Derives the durable plan artifact from a completed Claude plan run (Phase 5).
//
// This is the ONLY bridge between a plan run's raw stdout and a reviewable
// artifact, and it is deliberately ordered so no interleaving can produce a task
// that points at a plan which does not exist:
//
//   a. sanitize + bound        (pure)
//   b. write temp + fsync      (filesystem)
//   c. atomic rename           (filesystem — content becomes visible)
//   d. guarded SQLite attach   (attachPlanArtifact's three ownership checks)
//
// Steps b/c cannot be inside step d's transaction — filesystem and SQLite are
// separate commit domains. So a crash or a lost race after (c) leaves an orphan
// FILE with no row, which audited-plan-artifact-gc.ts reclaims. The reverse — a
// committed row with no file — is prevented by re-checking existence before (d).
import type Database from '../sqlite/sync-database'
import type { AuditedTaskRow } from './audited-task-row-mapping'
import {
  attachPlanArtifact,
  generatePlanArtifactId,
  type AttachPlanArtifactResult
} from './audited-plan-artifact-repository'
import {
  planArtifactFileExists,
  sanitizePlanText,
  writePlanArtifactFileAtomically,
  type PlanSanitizationContext
} from './audited-plan-artifact-store'

export type PlanArtifactDerivationResult =
  | { ok: true; artifactId: string; task: AuditedTaskRow }
  // The plan produced nothing reviewable once sanitized. Advancing to
  // awaiting_plan_review with an empty plan would be a lie.
  | { ok: false; kind: 'empty' }
  // The artifact could not be written, or a committed pointer would have
  // referenced a missing file.
  | { ok: false; kind: 'write_failed' }
  // Ownership was lost between the rename and the attach: a cancel, a startup
  // recovery, or an invariant block won. The winner's state stands untouched.
  | { ok: false; kind: 'not_owner'; reasonCode: string }

export type DerivePlanArtifactArgs = {
  taskId: string
  runId: string
  round: number
  rawPlanText: string
  sanitizationContext: PlanSanitizationContext
  counters: {
    stdoutBytes: number
    stderrBytes: number
    outputTruncated: boolean
    exitCode: number | null
  }
}

/**
 * Runs the four-step derivation. Never throws for an expected failure — the
 * caller must still finalize the execution run truthfully in every branch.
 */
export function derivePlanArtifact(
  db: Database.Database,
  userDataPath: string,
  args: DerivePlanArtifactArgs,
  nowMs: number
): PlanArtifactDerivationResult {
  // (a) Sanitize first: everything downstream — the hash, the byte count, the
  // stored file — describes the SANITIZED text, so no unsanitized bytes ever
  // reach disk under the artifact's name.
  const sanitized = sanitizePlanText(args.rawPlanText, args.sanitizationContext)
  if (!/\S/.test(sanitized.text)) {
    return { ok: false, kind: 'empty' }
  }

  // The id is generated BEFORE the write so the file path and the future row id
  // are the same value — that identity is what makes GC able to match them.
  const artifactId = generatePlanArtifactId()

  // (b) + (c)
  const written = writePlanArtifactFileAtomically(userDataPath, artifactId, sanitized.text)
  if (!written.ok) {
    return { ok: false, kind: 'write_failed' }
  }

  // A task must NEVER commit a pointer to an artifact whose file is absent.
  // Cheap, and it closes the window where the rename reported success but the
  // file is not actually readable back.
  if (!planArtifactFileExists(userDataPath, artifactId)) {
    return { ok: false, kind: 'write_failed' }
  }

  // (d) The guarded attach. Its three ownership checks decide whether this
  // derivation is still authorized to move the task.
  const attached: AttachPlanArtifactResult = attachPlanArtifact(
    db,
    {
      artifactId,
      taskId: args.taskId,
      runId: args.runId,
      round: args.round,
      contentSha256: written.sha256,
      charCount: written.charCount,
      truncated: sanitized.truncated,
      redactionCount: sanitized.redactionCount,
      counters: args.counters
    },
    nowMs
  )

  if (!attached.ok) {
    // The file is now an orphan. Deliberately NOT deleted here: this path also
    // runs when another writer legitimately won, and a best-effort unlink racing
    // that writer is exactly the kind of cleanup that deletes something still in
    // use. Startup GC reclaims it safely, with the DB as the authority.
    return { ok: false, kind: 'not_owner', reasonCode: attached.reasonCode }
  }

  return { ok: true, artifactId, task: attached.task }
}
