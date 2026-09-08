# TASK-AG-STORAGE-001: Audit `GlobalSettings` fields for credential-shaped data before CR-STORAGE-003 sync

**Task ID:** TASK-AG-STORAGE-001
**Priority:** 🔴 CRITICAL (blocks CR-STORAGE-003 elsewhere — security gate, not optional)
**Solution Ref:** [SOL-AG-STORAGE-001](../solutions/SOL-AG-STORAGE-001-track1-scope-and-credential-guardrail.md) §2
**Estimated effort:** Small (investigation only, no runtime code)
**Dependencies:** None
**Status:** ✅ Done (2026-09-07)

---

## Context

CR-STORAGE-003 (backend-go/frontend, not this repo area) proposes syncing
the **entire** `GlobalSettings` object (~200 fields,
`frontend/src/shared/types.ts:2524`) as one opaque JSON blob to
`tenant-service`. `SOL-AG-STORAGE-001` §2 established, by reading
`agent/src/relay/agent-credential-store.ts` and
`specs/agent/tdd/v5/09-ai-credential-relay.md`, that Dev Server Agent
already owns a **separate, dedicated** secure channel for AI provider
credentials (client-side encrypt → agent decrypt → `~/.orca/credentials/
<accountId>.enc` on the dev server, AES-256-GCM, plaintext never reaches
Orca Server). `GlobalSettings` fields named `codexManagedAccounts` /
`claudeManagedAccounts` (and possibly others) are suspected to reference
or contain data from this same domain — before CR-STORAGE-003 is allowed
to sync them wholesale, each field must be classified.

This task is **investigation-only** — it produces a classification list,
not a code change in `agent/src/`.

## What to do

1. Read `frontend/src/shared/types.ts`'s `GlobalSettings` type definition
   in full (not a partial grep) and list every field whose name suggests
   account/credential/token/key material — starting from, but not limited
   to: `codexManagedAccounts`, `claudeManagedAccounts`, `webPushSubscriptions`,
   `vapidKeys`.
2. For each such field, trace where it's populated/read on the frontend
   (`frontend/src/renderer/src/`) and cross-reference against
   `agent/src/relay/agent-credential-store.ts`'s `accountId`-keyed shape
   (`~/.orca/credentials/<accountId>.enc`) to determine:
   - **Metadata-only** (an `accountId` reference, display name, connection
     status, provider enum) → safe to sync opaque in `client_settings_json`.
   - **Contains or can contain key/token material** (even client-encrypted)
     → MUST be excluded from `client_settings_json`; must continue routing
     through the existing `ai.provider.writeCredential`/`readCredential`
     relay described in TDD-AG-09.
3. Produce a short classification table (field name → metadata-only |
   credential-shaped → excluded) as a new section appended to
   `SOL-AG-STORAGE-001-track1-scope-and-credential-guardrail.md` (§2, under
   a new "Kết quả audit" subsection) — do not create a separate file, this
   is a refinement of that solution's still-open item.
4. Do **not** modify `agent/src/` — this task has zero runtime-code scope.

## Acceptance Criteria

- [x] Every field in `GlobalSettings` with a name suggesting account/
      credential/token/key data has been individually classified.
- [x] Classification is grounded in reading actual code (frontend
      population site + `agent-credential-store.ts` shape), not guessed
      from field names alone.
- [x] `SOL-AG-STORAGE-001`'s §2 updated with the classification table and
      an explicit "safe to include" / "must exclude" list.
- [x] No file under `agent/src/` changed.

## Handoff

The exclusion list this task produces is a **hard input** to
`BE-SOL-STORAGE-001`/`FE-SOL-STORAGE-003` (backend-go/frontend tracks) —
flag to whoever implements those that this list must be read first.

---

## ✅ Completion Notes (2026-09-07)

Read `GlobalSettings`'s full type definition (`frontend/src/shared/types.ts`,
cross-checked identical copies in `backend/`/`desktop/`/`agent/src/shared/types.ts`)
via `codegraph_explore`, plus `agent/src/relay/agent-credential-store.ts`'s
shape for comparison. Full classification recorded in
`SOL-AG-STORAGE-001` §2a.

**Result:**
- `codexManagedAccounts` / `claudeManagedAccounts` → **safe, metadata-only**
  (`id`/`email`/a local filesystem path/`createdAt`/`updatedAt` — no token
  or key field in either type). Safe to include in `client_settings_json`.
- `vapidKeys: { publicKey, privateKey } | null` → **must exclude** — contains
  a real private key (VAPID signing key for Web Push), confirmed by reading
  the field's own doc comment and shape.
- `webPushSubscriptions` → **should exclude pending further review** —
  `endpoint`+`keys` subscription data is credential-shaped (bearer-like for
  push delivery), even though it doesn't contain the VAPID private key
  itself.
- Bonus finding (out of this task's fix-scope, flagged only):
  `vapidKeys.privateKey` already sits inside `GlobalSettings` today, before
  any CR-STORAGE-003 change — any settings-write path that round-trips the
  full object already has a latent "client can overwrite the server's own
  push-signing key" risk, independent of this CR. Recorded in the solution
  doc, not fixed here (out of scope).
