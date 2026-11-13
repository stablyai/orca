// Audit events that happen in another Orca service (auth: invites, team rename, SSO, SCIM and MFA
// policy; billing: plan changes) arrive here, so the team audit log reads one store.
//
//   POST /v1/internal/audit-events {accountId, events: [{eventId, action, at?, actorUserId?, target?, detail?}]}
//     -> {recorded, duplicates}
//
// Auth's token (MEMBER_REMOVED_TOKEN) writes member, team, sso, scim and mfa events; billing's
// (CONTROL_PLANE_TOKEN) writes billing events and nothing else; the operator token writes any.
// The route only appends: it can't read, change or delete a row. `eventId` makes a retry a no-op. Actions are limited to the
// families those services own, so a pushed event can never pass for an API key or secret change.
// Member removal and role changes are not sent here: they have their own pushes, which also do
// the cleanup, and record the event themselves (actorUserId on those bodies).
import { z } from 'zod'

const EVENT_FAMILIES = ['member', 'team', 'sso', 'scim', 'mfa', 'billing'] as const
export type AuditEventFamily = (typeof EVENT_FAMILIES)[number]
/** What each sender may write, so one service's bearer can't forge another's events. */
export const AUTH_EVENT_FAMILIES: readonly AuditEventFamily[] = ['member', 'team', 'sso', 'scim', 'mfa']
export const BILLING_EVENT_FAMILIES: readonly AuditEventFamily[] = ['billing']
export const ALL_EVENT_FAMILIES: readonly AuditEventFamily[] = EVENT_FAMILIES
const ACTION = new RegExp(`^(${EVENT_FAMILIES.join('|')})\\.[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)?$`)
/** Recorded by this service from the member pushes; a second copy from outside would double them. */
const OWNED_HERE = new Set(['member.removed', 'member.left', 'member.role_changed', 'member.role_synced'])

const Id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/)
const SENSITIVE_DETAIL_KEY = /secret|token|password|passphrase|hint|value|ciphertext|credential|private|code/i
const MAX_DETAIL_BYTES = 2048

const EventSchema = z
  .object({
    eventId: z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/),
    action: z.string().max(80).regex(ACTION),
    /** When it happened (ms). Clamped to now: a sender's fast clock can't post-date the log. */
    at: z.number().int().positive().optional(),
    /** The person who did it; omitted when the service itself did (a scheduler, a directory sync). */
    actorUserId: Id.optional(),
    target: z
      .object({
        type: z.enum(['member', 'invite', 'team', 'sso_connection', 'scim_directory', 'scim_group', 'policy', 'plan']),
        id: Id.optional(),
        /** Display text: an invitee's email, a group or connection name. */
        label: z.string().min(1).max(200).optional()
      })
      .strict()
      .optional(),
    detail: z.record(z.string().max(64), z.union([z.string().max(300), z.number(), z.boolean(), z.null()])).optional()
  })
  .strict()

export const AuditIngestSchema = z
  .object({
    accountId: z.string().min(1).max(160).regex(/^(org|dev:org):[A-Za-z0-9_.:-]+$/),
    events: z.array(EventSchema).min(1).max(50)
  })
  .strict()

export type AuditIngestBody = z.infer<typeof AuditIngestSchema>

export class AuditIngestError extends Error {}

/** Appends the events; one that was already recorded (same eventId) is skipped. */
export async function ingestAuditEvents(
  db: D1Database,
  body: AuditIngestBody,
  now: number,
  families: readonly AuditEventFamily[] = ALL_EVENT_FAMILIES
): Promise<{ recorded: number; duplicates: number }> {
  const statements: D1PreparedStatement[] = []
  for (const event of body.events) {
    if (!(families as readonly string[]).includes(event.action.split('.')[0]!)) {
      throw new AuditIngestError(`action_not_allowed_for_sender:${event.action}`)
    }
    if (OWNED_HERE.has(event.action)) {
      throw new AuditIngestError(`action_recorded_by_control_plane:${event.action}`)
    }
    const detail: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(event.detail ?? {})) {
      if (SENSITIVE_DETAIL_KEY.test(key)) {
        // Refused rather than dropped, so a sender finds out in its own tests.
        throw new AuditIngestError(`detail_key_not_allowed:${key}`)
      }
      detail[key] = value
    }
    if (event.target?.label) {
      detail.name = event.target.label
    }
    const text = Object.keys(detail).length ? JSON.stringify(detail) : null
    if (text && text.length > MAX_DETAIL_BYTES) {
      throw new AuditIngestError('detail_too_large')
    }
    const actor = event.actorUserId
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO audit_log (id, account_id, actor_type, actor_id, user_id, action, target_type, target_id, detail, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          `aud_x_${event.eventId}`,
          body.accountId,
          actor ? 'user' : 'system',
          actor ?? event.action.split('.')[0]!,
          actor ?? null,
          event.action,
          event.target?.type ?? null,
          event.target?.id ?? null,
          text,
          Math.min(event.at ?? now, now)
        )
    )
  }
  const results = await db.batch(statements)
  const recorded = results.reduce((sum, result) => sum + (result.meta.changes ?? 0), 0)
  return { recorded, duplicates: body.events.length - recorded }
}
