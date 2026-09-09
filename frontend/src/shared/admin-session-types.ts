// ─── Admin Session Types ─────────────────────────────────────────────────
// Backs the Admin Console's per-user Sessions panel — mirrors the
// `sessionView` shape api-gateway's channels_admin_sessions.go returns for
// admin.listSessions / forceRevokeSession / forceRevokeAllSessions. Pure
// type file — no imports from other project modules.
//
// There is no cross-user "list all sessions" RPC (only ListSessionsForUser,
// scoped to one userId) — see admin-org-console-sessions-tab.tsx's doc
// comment for how the UI is shaped around that constraint.

export type AdminSession = {
  sessionId: string
  userId: string
  ip: string
  userAgent: string
  createdAtUnixMs: number
  expiresAtUnixMs: number
  lastSeenAtUnixMs: number
}
