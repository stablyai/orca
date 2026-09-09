// ─── Admin Audit Log Types ───────────────────────────────────────────────
// Backs the Admin Console's Audit Log tab — mirrors the `auditEntryView`
// shape api-gateway's channels_admin_audit.go returns for
// admin.queryAuditLog. Pure type file — no imports from other project
// modules.
//
// FE-TASK-014 (CR-RBAC-005): outcome/actorId filtering. The backend channel
// already accepts/returns these fields (written directly against the full
// filter set — see channels_admin_audit.go's doc comment), so no
// two-pass base-then-filters split was needed on the frontend either.

export type AdminAuditOutcome = 'allowed' | 'denied'

export type AdminAuditEntry = {
  id: string
  actorId: string
  action: string
  /** Resource the action targeted — mirrors auditEntryView's `target` json
   *  key (auth-service's AuditEntry.target), not `resourceType`/`resourceId`. */
  target: string
  outcome: string
  ipAddress: string
  occurredAtUnixMs: number
}

export type AdminAuditQuery = {
  sinceUnixMs?: number
  actorId?: string
  action?: string
  outcome?: AdminAuditOutcome
  pageToken?: string
  pageSize?: number
}
