// Single use for signed admin tokens. Each admin op targets one HostRelay (by relayHostId), so the
// object keeps the token ids (`jti`) it has accepted in one storage key and refuses a repeat. The
// check runs inside the object, which handles one event at a time: the read and the write are both
// storage operations, so no other call can run between them (input gate), and two copies of one
// token racing each other cannot both pass.
// Entries live until the token could no longer verify (exp or iat + 2 min, whichever is first)
// plus clock slack between the Worker and the object; expired ones are dropped on every call, so
// the map holds at most the host's admin calls of the last few minutes. Only a token signed with
// the director's (or erasure job's) key can add an entry.
export const ADMIN_JTI_KEY = 'adminJtis'
export const ADMIN_JTI_SLACK_MS = 60_000
// Far above any real per-host call rate; past it the object refuses rather than forgets ids.
export const ADMIN_JTI_MAX = 512

// What the Worker hands the object for a token that carried a jti.
export type AdminReplayGuard = { jti: string; expiresAt: number }
export type SeenJtis = Record<string, number>
// What an admin op answers instead of running (409): a reused jti, or a host whose map is full.
export type ReplayRefusal = { outcome: 'replay' | 'jti_full' }
export type JtiAdmission = { outcome: 'fresh' | ReplayRefusal['outcome']; seen: SeenJtis }

export function admitJti(stored: SeenJtis | undefined, guard: AdminReplayGuard, now: number): JtiAdmission {
  const seen: SeenJtis = {}
  for (const [jti, until] of Object.entries(stored ?? {})) {
    if (until > now) { seen[jti] = until }
  }
  if (Object.hasOwn(seen, guard.jti)) { return { outcome: 'replay', seen } }
  if (Object.keys(seen).length >= ADMIN_JTI_MAX) { return { outcome: 'jti_full', seen } }
  seen[guard.jti] = guard.expiresAt + ADMIN_JTI_SLACK_MS
  return { outcome: 'fresh', seen }
}
