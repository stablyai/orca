# BE-SOL-008: Wire the missing `admin.*` wscompat channels — Policies, Sessions, Audit, Teams

> **🔲 Proposed — not implemented.** No production code changed writing this
> document.

**CR:** [CR-RBAC-001](../../../../../../docs/crs/v4/team-rbac/CR-RBAC-001-consolidate-admin-surface-to-backend-go.md)
**Service:** api-gateway (wscompat layer only — no other backend-go service touched)
**Fills the gap identified in:** [FE-SOL-004](../../../../frontend/crs/v4/team-rbac/solutions/FE-SOL-004-consolidate-admin-spa-into-admin-org-console.md)
(the frontend cutover's transport is `window.api.admin.*` → wscompat, **not**
the `/admin/api/*` REST surface the legacy `backend/` serves) and confirmed
missing by the `specs/backend-go/crs/v4/team-rbac/tasks/` README's own
"honest gap" note: BE-SOL-001 only *audited* the gRPC-level RPC surface, it
never designed the wscompat channels that surface needs to reach the browser.
**Depends on:** [BE-SOL-001](./BE-SOL-001-admin-rpc-surface-audit.md) (confirms/adds `ForceRevokeSession`),
softly on [BE-SOL-005](./BE-SOL-005-audit-log-outcome-and-coverage.md) (audit filters) and
[BE-SOL-006](./BE-SOL-006-opa-policy-publish-and-reload.md) (policy publish) — see §5 for which parts
are a hard vs. soft dependency.

---

## 1. Problem

`channels_admin_users.go` (`registerAdminUserChannels`) is the **only**
`admin.*` wscompat file that exists. It wires 5 channels
(`admin.createUser`/`.listUsers`/`.updateUserRole`/`.deactivateUser`/
`.reactivateUser`) to `auth-service`'s already-implemented gRPC methods —
confirmed via `codegraph_explore` this pass, and independently by BE-SOL-001's
RPC audit. No `admin.*Policy*`, `admin.*Session*`, `admin.queryAuditLog`, or
`admin.*Team*` channel exists anywhere in
`backend-go/services/api-gateway/internal/adapter/wscompat/`.

This matters because `frontend/`'s `AdminOrgConsole.tsx` (the backend-go-facing
Admin UI CR-RBAC-001 cutover targets) talks to backend-go exclusively through
`window.api.admin.*` → this wscompat registry — **not** through the legacy
`/admin/api/*` REST client (`admin-api-client.ts`) that the *old*, to-be-retired
`AdminApp` SPA uses. So even though `auth-service` and `tenant-service`
already implement every gRPC method the Policies/Sessions/Audit/Teams tabs
need (per BE-SOL-001 §2), **none of it is reachable from the browser today**
via the transport the target UI actually uses. Without this solution,
CR-RBAC-001's frontend tasks (FE-TASK-018/019/020/021, one per tab) have
nothing to call.

## 2. Solution — 4 new files, one per tab, mirroring `channels_admin_users.go`'s exact shape

Each new file: one `register...Channels(r *Registry, client ...)` function,
called once from the same composition root `channels_admin_users.go`'s own
caller already lives in (`RegisterRealChannels` in `channels.go` — confirmed
via `codegraph_explore`'s call graph: `registerTenantProjectChannels` and
`registerAdminUserChannels` are both invoked there today; the 4 new functions
join that same list). Every channel: `if id.Role != "admin" { return nil,
errNotAdmin }` first line (wscompat-layer gate, same defense-in-depth
reasoning `channels_admin_users.go`'s header comment already documents —
auth-service's own `requireAdminActor` still gates server-side regardless).

### 2.1 `channels_admin_policies.go` — `registerAdminPolicyChannels(r, authClient)`

| Channel | Args | Calls | Returns |
|---|---|---|---|
| `admin.listPolicies` | `{pageToken?, pageSize?}` | `ListAccessPolicies` | `{policies: policyView[], nextPageToken}` |
| `admin.getPolicy` | `{policyId}` | `GetAccessPolicy` | `policyView` |
| `admin.createPolicy` | `{name, kind, documentJson}` | `CreateAccessPolicy` | `policyView` |
| `admin.updatePolicy` | `{policyId, documentJson}` | `UpdateAccessPolicy` | `policyView` |
| `admin.deletePolicy` | `{policyId}` | `DeleteAccessPolicy` | `{ok: true}` |

```go
type policyView struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Kind        string `json:"kind"`
	DocumentJSON string `json:"documentJson"`
	Version     int32  `json:"version"`
	UpdatedBy   string `json:"updatedBy"`
	UpdatedAtUnixMs int64 `json:"updatedAtUnixMs"`
}
```

`documentJson` passes through as an opaque string (the admin console's policy
editor is a raw-JSON/Rego-data textarea, not a structured form — consistent
with `AccessPolicy.document_json`'s own design, see BE-SOL-006 §"AccessPolicy
CRUD"). No client-side validation of the JSON shape beyond "is it valid JSON"
— `UpdateAccessPolicy`'s own compile-before-accept check (BE-SOL-006 §"validate
chặt") is where real validation happens.

### 2.2 `channels_admin_sessions.go` — `registerAdminSessionChannels(r, authClient)`

| Channel | Args | Calls | Returns |
|---|---|---|---|
| `admin.listSessions` | `{userId}` | `ListSessionsForUser` | `{sessions: sessionView[]}` |
| `admin.forceRevokeAllSessions` | `{userId}` | `ForceRevokeAllSessionsForUser` | `{ok: true}` |
| `admin.forceRevokeSession` | `{sessionId}` | `ForceRevokeSession` **(new RPC — see §5.1, hard dependency)** | `{ok: true}` |

```go
type sessionView struct {
	SessionID     string `json:"sessionId"` // token_hash, per BE-SOL-001's ForceRevokeSessionRequest sketch
	UserID        string `json:"userId"`
	IPAddress     string `json:"ipAddress"`
	UserAgent     string `json:"userAgent"`
	CreatedAtUnixMs  int64 `json:"createdAtUnixMs"`
	LastSeenAtUnixMs int64 `json:"lastSeenAtUnixMs"`
}
```

`admin.forceRevokeSession` is written against BE-SOL-001's proposed
`ForceRevokeSession(ForceRevokeSessionRequest{session_id}) → Empty` RPC. If
BE-SOL-001's §3 verification finds `RevokeSession` already supports an
admin-supplied target session for *any* user (its "if wrong" branch), this
channel calls `RevokeSession` instead and the proto/usecase task disappears —
**verify BE-SOL-001 §3's outcome before implementing this one channel**
(the other 2 sessions channels and all of §2.1/§2.3/§2.4 have no such
dependency).

### 2.3 `channels_admin_audit.go` — `registerAdminAuditChannels(r, authClient)`

| Channel | Args | Calls | Returns |
|---|---|---|---|
| `admin.queryAuditLog` | `{since?, actorId?, action?, resourceType?, outcome?, pageToken?, pageSize?}` | `QueryAuditLog` | `{entries: auditEntryView[], nextPageToken}` |

```go
type auditEntryView struct {
	ID              string `json:"id"`
	ActorID         string `json:"actorId"`
	Action          string `json:"action"`
	Target          string `json:"target"`
	Outcome         string `json:"outcome"`         // "" until BE-SOL-005 ships the column — see §5.2
	IPAddress       string `json:"ipAddress"`        // "" until BE-SOL-005 ships the column
	OccurredAtUnixMs int64 `json:"occurredAtUnixMs"`
}
```

Wire the channel to accept and forward `actorId`/`resourceType`/`outcome` as
`QueryAuditLogRequest` fields **now** — even though, until BE-SOL-005 lands,
`QueryAuditLogRequest` has no such fields to receive them (today it's only
`tenant_id`+`since`+pagination, per BE-SOL-005 §"QueryAuditLog"). Sequencing
choice: wire the channel's Go struct/decode shape ahead of time so the
Audit-tab frontend task (FE-TASK-019) isn't blocked waiting on this file to
be touched twice — the actual filter *fields* on `QueryAuditLogRequest` are
BE-SOL-005's job, added independently; this channel just forwards whatever
fields exist on the request message at the time each lands (see §5.2 for the
two-step sequencing this implies).

### 2.4 `channels_admin_teams.go` — `registerAdminTeamChannels(r, tenantClient)`

| Channel | Args | Calls | Returns |
|---|---|---|---|
| `admin.listTeams` | `{pageToken?, pageSize?}` | `ListTeams` | `{teams: teamView[], nextPageToken}` |
| `admin.createTeam` | `{name}` | `CreateTeam` | `teamView` |
| `admin.listTeamMembers` | `{teamId}` | `ListTeamMembers` | `{members: teamMemberView[]}` |
| `admin.addTeamMember` | `{teamId, userId, priority?}` | `AddTeamMember` | `{ok: true}` |
| `admin.removeTeamMember` | `{teamId, userId}` | `RemoveTeamMember` | `{ok: true}` |

```go
type teamView struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type teamMemberView struct {
	TeamID   string `json:"teamId"`
	UserID   string `json:"userId"`
	Priority int32  `json:"priority"`
}
```

**Deliberately no `role` field anywhere in this file.** `tenant-service`'s
`TeamMember{TeamID, UserID, Priority}` (confirmed, both in this pass's own
audit and CR-RBAC-002/004) has no role concept — `Priority` is a
settings-inheritance tiebreaker, not a permission tier. The *old*, to-be-
retired `TeamAdmin.tsx` let an admin type a free-text `role` string into a
field the backend never persisted as anything meaningful; **do not
resurrect that field here.** If a future CR adds real per-team roles, that's
a `tenant-service` domain change (new column + proto field) — out of scope
for this wiring-only solution.

## 3. Files to change

| File | Change |
|---|---|
| `backend-go/services/api-gateway/internal/adapter/wscompat/channels_admin_policies.go` (new) | `registerAdminPolicyChannels` — 5 channels |
| `backend-go/services/api-gateway/internal/adapter/wscompat/channels_admin_policies_test.go` (new) | Fake-client tests, one per channel, admin-gate test mirroring `channels_admin_users_test.go`'s pattern |
| `backend-go/services/api-gateway/internal/adapter/wscompat/channels_admin_sessions.go` (new) | `registerAdminSessionChannels` — 3 channels |
| `backend-go/services/api-gateway/internal/adapter/wscompat/channels_admin_sessions_test.go` (new) | Same pattern |
| `backend-go/services/api-gateway/internal/adapter/wscompat/channels_admin_audit.go` (new) | `registerAdminAuditChannels` — 1 channel |
| `backend-go/services/api-gateway/internal/adapter/wscompat/channels_admin_audit_test.go` (new) | Same pattern |
| `backend-go/services/api-gateway/internal/adapter/wscompat/channels_admin_teams.go` (new) | `registerAdminTeamChannels` — 5 channels |
| `backend-go/services/api-gateway/internal/adapter/wscompat/channels_admin_teams_test.go` (new) | Same pattern |
| `backend-go/services/api-gateway/internal/adapter/wscompat/channels.go` | Add 4 `register...Channels(r, ...)` calls to `RegisterRealChannels`, next to the existing `registerAdminUserChannels` call |
| `frontend/src/preload/api-types.ts`, `frontend/src/renderer/src/web/web-preload-api.ts` | Add the 14 new `window.api.admin.*` method signatures (frontend scope — listed here for completeness, actual edit belongs to CR-RBAC-001's frontend tasks, e.g. FE-TASK-018..021) |

## 4. Out of scope

- Any change to `auth-service`/`tenant-service` gRPC methods themselves —
  BE-SOL-001 already confirmed they exist (except `ForceRevokeSession`,
  which is that solution's own scope, not this one's).
- `QueryAuditLogRequest`'s new filter fields — BE-SOL-005's scope; this
  solution only wires the wscompat pass-through shape (§2.3).
- `AccessPolicy` publish-to-OPA-bundle behavior — BE-SOL-006's scope; this
  solution only exposes the CRUD RPCs that already exist regardless of
  whether publish is a no-op yet.
- Legacy `backend/`'s `/admin/api/*` retirement — separate, `frontend`+legacy
  cutover concern (CR-RBAC-001's own "Changes Required" table).
- A `role` field on `TeamMember` — explicitly not reintroduced (§2.4).

## 5. Dependency detail (hard vs. soft)

### 5.1 Hard dependency: `admin.forceRevokeSession` ← BE-SOL-001 §3

The single-session revoke channel cannot be implemented until BE-SOL-001's
own open question ("does `RevokeSession` already support admin-revoke-any, or
is `ForceRevokeSession` a genuinely new RPC") is resolved. The other 13
channels across §2.1/2.2 (minus this one)/2.3/2.4 have no such blocker.

### 5.2 Soft dependency: `admin.queryAuditLog`'s filters ← BE-SOL-005

Wiring the channel itself has no dependency (it can forward `since` +
pagination today, exactly like the gRPC method already supports). The
`actorId`/`resourceType`/`outcome` args become *effective* only once
BE-SOL-005 adds those fields to `QueryAuditLogRequest` and the underlying
schema/repository query. Recommendation: implement this channel in two
passes — the base channel now (unblocks the Audit tab showing *something*),
a small follow-up diff adding the 3 new field mappings once BE-SOL-005 lands
(likely a 10-line diff to this same file, not a new file).

### 5.3 Soft dependency: `admin.updatePolicy`/`admin.createPolicy` ← BE-SOL-006

No wiring dependency — these channels call `CreateAccessPolicy`/
`UpdateAccessPolicy` today regardless of whether `NoopPublisher` is still a
stub. The *effect* of an edit (does OPA actually enforce it) depends on
BE-SOL-006, not this solution. Sequencing note only, not a blocker to
implementing §2.1.

## 6. Tests

One test file per new channel file, same shape as
`channels_admin_users_test.go`'s existing pattern (a `fake...Client` struct
per gRPC client interface consumed, one `Test...Channel_RequiresAdmin` per
channel asserting `errNotAdmin` on a non-admin `Identity`, one
`Test...Channel_Success` per channel asserting the fake client received the
right request and the channel returned the right view shape).

## 7. Impact analysis (gitnexus)

| Symbol | Direction | Risk | Impacted | Note |
|---|---|---|---|---|
| `registerAdminUserChannels` (nearest existing analog — new functions will be added alongside it in the same composition root) | upstream | LOW | 3 (1 direct, 1 process `run` in `api-gateway/cmd/server/main.go`) | Confirmed live this pass. The 4 new `register...Channels` functions being *added* have no prior impact to measure (they don't exist yet) — run `impact({target:"RegisterRealChannels", direction:"upstream"})` immediately before editing `channels.go` to confirm its blast radius hasn't changed since this pass. |

`detect_changes()` after implementing should show only new files +
`channels.go`'s 4 new call lines — no existing channel's behavior changes.

## 8. Sequencing note (updates the CR set's own README)

```
BE-SOL-002 (role model) ─┐
BE-SOL-004 (already fixed, verification only) │ independent, parallel
BE-SOL-005 (audit schema)  │
BE-SOL-006 (policy publish) ─┘
                    │
                    ▼
BE-SOL-001 (admin RPC surface audit — resolves whether ForceRevokeSession is new)
                    │
                    ▼
BE-SOL-008 (this doc) ← NEW. Can start §2.1/§2.3(base)/§2.4 in parallel with
                          BE-SOL-001 (no dependency on its outcome); §2.2's
                          `admin.forceRevokeSession` channel waits on
                          BE-SOL-001 §3's answer specifically.
                    │
                    ▼
CR-RBAC-001's frontend cutover (FE-TASK-017..021) — now has something to call.
```
