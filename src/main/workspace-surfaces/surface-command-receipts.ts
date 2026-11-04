import type Database from '../sqlite/sync-database'
import { stableJson } from '../../shared/workspace-layout/workspace-layout-load-report'
import {
  surfaceCommandOutcomeSchema,
  type SurfaceCommandIdentity,
  type SurfaceCommandOutcome
} from '../../shared/workspace-surfaces/surface-command'
import { parseJson } from './surface-rows'

export const MAX_SURFACE_COMMAND_LIFETIME_MS = 720_000

/** Reusable inside the admitted owner transaction; no transaction or queue is opened here. */
export function runSurfaceCommand(
  db: Database.Database,
  identity: SurfaceCommandIdentity,
  input: unknown,
  now: () => number,
  apply: () => SurfaceCommandOutcome
): SurfaceCommandOutcome {
  const fingerprint = stableJson(input)
  const receipt = db
    .prepare(
      'SELECT fingerprint, result_json FROM main.workspace_surface_commands WHERE host_id = ? AND caller_id = ? AND command_id = ?'
    )
    .get(identity.hostId, identity.callerId, identity.commandId)
  if (receipt) {
    if (receipt.fingerprint !== fingerprint) {
      return { status: 'conflict', code: 'command_identity_conflict', current: null }
    }
    return surfaceCommandOutcomeSchema.parse(parseJson(receipt.result_json))
  }
  if (!Number.isSafeInteger(identity.expiresAt) || identity.expiresAt <= now()) {
    return { status: 'conflict', code: 'command_expired', current: null }
  }
  if (identity.expiresAt > now() + MAX_SURFACE_COMMAND_LIFETIME_MS) {
    return { status: 'conflict', code: 'command_deadline_too_far', current: null }
  }
  if (
    db
      .prepare('SELECT initialized FROM main.workspace_surface_domains WHERE host_id = ?')
      .get(identity.hostId)?.initialized !== 1
  ) {
    throw new Error('surface_domain_not_initialized')
  }
  const outcome = surfaceCommandOutcomeSchema.parse(apply())
  db.prepare('DELETE FROM main.workspace_surface_commands WHERE expires_at <= ?').run(now())
  db.prepare(`INSERT INTO main.workspace_surface_commands
    (host_id, caller_id, command_id, fingerprint, expires_at, result_json)
    VALUES (?, ?, ?, ?, ?, ?)`).run(
    identity.hostId,
    identity.callerId,
    identity.commandId,
    fingerprint,
    identity.expiresAt,
    JSON.stringify(outcome)
  )
  return outcome
}
