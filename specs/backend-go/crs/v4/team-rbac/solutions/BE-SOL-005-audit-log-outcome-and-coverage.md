# BE-SOL-005: Add `outcome`/`ip_address` to `AuditEntry`; audit OPA decisions in project/task/annotation/infra-fleet-service

> **🔲 Proposed — not implemented.**

**CR:** [CR-RBAC-005](../../../../../../docs/crs/v4/team-rbac/CR-RBAC-005-audit-log-outcome-and-coverage.md)
**Service:** auth-service (schema owner) + project-service, task-service,
annotation-service, infra-fleet-service (new audit-emission call sites) +
api-gateway (IP propagation)
**Depends on:** none — independent, should land before CR-RBAC-001 (Admin UI
audit tab needs the new columns/filters to be worth cutting over to).

---

## 1. Problem (confirmed)

`domain.AuditEntry` (`backend-go/services/auth-service/internal/domain/audit.go:23-30`)
is exactly `{ID, TenantID, ActorID, Action, Target, OccurredAt}` — no
`outcome`, no `ip_address`. `audit.audit_log`'s schema
(`backend-go/services/auth-service/migrations/0001_init.up.sql:49-56`)
matches 1:1 (no such columns). `postgres.Repository.Query`
(`audit_repository.go:30-59`) only filters `tenant_id`+`since`+pagination —
confirmed there are no `actor_id`/`action`/`resource_type`/`outcome` filter
parameters anywhere in `QueryAuditLogInput`
(`auth-service/internal/usecase/query_audit_log.go:11-16`).

Confirmed via `codegraph_explore`: `requireAdminActor`
(`auth-service/internal/usecase/authorization.go:19-39`) — the one
authorization gate auth-service itself uses — has **15 callers** across its
own admin-console usecases, none of which append an audit entry on deny (only
`update_user_role.go` and a few others append on *success*, per the CR's
original audit). `project-service`'s `requireProjectAccess`/`requireRepoAccess`,
`task-service`'s and `annotation-service`'s `OPAClient.Decision` call sites
have **zero** audit-append calls anywhere — confirmed no
`AuditRepository`/`audit.Append`-shaped port exists in any of those three
services' `usecase/ports.go` today (only auth-service owns `AuditRepository`).

## 2. Solution

### A. Schema + domain: `Outcome` and `IPAddress`

`backend-go/services/auth-service/migrations/0004_audit_outcome_and_ip.up.sql`
(next number after `0003_sso_identities` — confirmed via `ls migrations/`):

```sql
ALTER TABLE auth.audit_log
    ADD COLUMN outcome     TEXT NOT NULL DEFAULT 'allowed' CHECK (outcome IN ('allowed', 'denied')),
    ADD COLUMN ip_address  INET;

CREATE INDEX idx_audit_log_outcome ON auth.audit_log (tenant_id, outcome);
```

`0004_audit_outcome_and_ip.down.sql`:

```sql
DROP INDEX IF EXISTS auth.idx_audit_log_outcome;
ALTER TABLE auth.audit_log DROP COLUMN IF EXISTS outcome, DROP COLUMN IF EXISTS ip_address;
```

`backend-go/services/auth-service/internal/domain/audit.go`:

```go
type Outcome string

const (
	OutcomeAllowed Outcome = "allowed"
	OutcomeDenied  Outcome = "denied"
)

func (o Outcome) Valid() bool {
	switch o {
	case OutcomeAllowed, OutcomeDenied:
		return true
	default:
		return false
	}
}

type AuditEntry struct {
	ID         string
	TenantID   string
	ActorID    string
	Action     string
	Target     string
	Outcome    Outcome // defaults to OutcomeAllowed for pre-existing call sites, see NewAuditEntry
	IPAddress  string  // empty for entries appended by a service with no HTTP-request context (e.g. a background job)
	OccurredAt time.Time
}

// NewAuditEntry's signature grows an Outcome parameter. Every existing call
// site (auth-service's own success-path audit calls) passes OutcomeAllowed —
// see "Files to change" for the mechanical update.
func NewAuditEntry(id, tenantID, actorID, action, target string, outcome Outcome, ipAddress string, occurredAt time.Time) (AuditEntry, error) {
	// ... existing checks ...
	if outcome == "" {
		outcome = OutcomeAllowed // backward-compatible default, not an error — see domain.AuditEntry's doc comment
	}
	if !outcome.Valid() {
		return AuditEntry{}, ErrInvalidOutcome
	}
	return AuditEntry{ID: id, TenantID: tenantID, ActorID: actorID, Action: action, Target: target, Outcome: outcome, IPAddress: ipAddress, OccurredAt: occurredAt}, nil
}
```

`postgres.Repository.Append`/`Query` (`audit_repository.go`) gain the two
columns; `Query` gains `actor_id`/`action`/`outcome` optional filters (empty
string / zero value = no filter, matching this codebase's established
"empty = no filter" convention seen in `ListDevServersForUserInput.Kind`).

### B. Cross-service audit emission: `AppendAuditEntry` RPC

Since `audit.audit_log` lives in `auth-service`'s own Postgres schema (per
`auth-service.md` §2's bounded-context rule — no other service gets a direct
DB connection to it), `project-service`/`task-service`/`annotation-service`/
`infra-fleet-service` need a way to append an entry. Add one small RPC:

`auth.proto` (new RPC on `AuthService`):

```protobuf
rpc AppendAuditEntry(AppendAuditEntryRequest) returns (google.protobuf.Empty);

message AppendAuditEntryRequest {
  string tenant_id = 1;   // from the caller's own validated context, not client input
  string actor_id = 2;
  string action = 3;      // e.g. "project.update", "repo.remove_member", "ssh.connect"
  string target = 4;      // resource type + id, e.g. "project:proj-123"
  string outcome = 5;     // "allowed" | "denied"
  string ip_address = 6;
}
```

New usecase `AppendAuditEntry` (auth-service) — thin wrapper around
`AuditRepository.Append`, **no `requireAdminActor` gate** (this is a
service-to-service call, not an admin-console action; every other service
authenticates to auth-service the same way api-gateway does — via mTLS +
NetworkPolicy per `07-security-architecture.md`, not per-call user
authorization). Validates `tenant_id`/`action` non-empty, constructs
`domain.NewAuditEntry`, appends.

`backend-go/common/auditclient/` (new small shared package, following the
"cross-service shared code policy" in `03-clean-architecture-guidelines.md`
— this is a thin gRPC client wrapper, not a domain type or usecase, so it
qualifies for `common/` the same way `common/grpcmw`/`common/tenant` do):

```go
// Package auditclient is the thin gRPC client every non-auth-service uses to
// append an audit entry to auth-service's audit_log — audit_log is
// auth-service's own schema (auth-service.md §2), so no other service talks
// to its Postgres directly.
package auditclient

type Client struct {
	auth authv1.AuthServiceClient
}

func New(auth authv1.AuthServiceClient) *Client { return &Client{auth: auth} }

// Append is best-effort: an audit-append failure is logged, never returned
// to the caller as an error — a permission-check RPC's own success/failure
// must never depend on the audit system being reachable (matches
// auth-service's own audit calls, which never roll back the primary
// operation on an audit-write failure — see update_access_policy.go's doc
// comment on PublishPolicyChange's identical non-blocking posture).
func (c *Client) Append(ctx context.Context, tenantID, actorID, action, target, outcome, ipAddress string) {
	_, err := c.auth.AppendAuditEntry(ctx, &authv1.AppendAuditEntryRequest{...})
	if err != nil {
		slog.WarnContext(ctx, "auditclient: failed to append audit entry", "action", action, "error", err)
	}
}
```

### C. Wire it into the 4 OPA-gated call sites

- `project-service`'s `requireProjectAccess`/`requireRepoAccess`
  (`authorization.go:69,108`): after `opa.Decision`/`opa.RepoDecision`
  resolves (both the `allowed` and `!allowed` branches), call
  `auditClient.Append(ctx, tenantID, actorID, action, "project:"+projectID, outcome, ip)`.
  Both functions already have every value this needs in scope.
- `task-service`: audit the grant-resolution decision in whichever usecase
  calls `opaclient.Client.Decision` (`task-service/internal/adapter/opaclient/client.go:53`,
  input `level`/`action`/`tenantID`) — verify the exact call site at
  implementation time (not traced in this pass; `codegraph_explore` showed
  the client but not its usecase caller in the token budget available —
  **run `codegraph_explore("task-service Decision opaclient")` before
  implementing this bullet**, per the repo's discovery-first rule).
- `annotation-service`: same, at its `OPAClient.Decision` call site
  (`annotation-service/internal/adapter/opaclient/client.go:36`) —
  same verify-before-implementing note.
- `infra-fleet-service`: audit `ListDevServersForUser`'s access decisions
  would be noisy (it's a list, not a single allow/deny); the CR's real target
  is the dev-server **connect** action ("ssh.connect", F32's own example) —
  verify which usecase actually gates an SSH/PTY connection attempt
  (`EstablishConnection`, `SpawnTerminalSession`?) before wiring, since this
  wasn't traced in this pass either.

### D. IP address propagation

`api-gateway`'s `authMiddleware`/`wscompat` bridge already has `r.RemoteAddr`
(the one place with a real client IP — internal services see only the
gateway's IP if they tried to read it themselves, which is exactly why
`05-data-architecture.md`'s pattern of "resolve once at the edge, pass
explicitly" applies here too). Extract IP in `withIdentity`/`AttachIdentity`'s
call sites and forward it the same way `TenantID`/`UserID`/`Role` already
travel — either as a 4th `grpcmw` metadata key (`x-orca-client-ip`) or as an
explicit parameter on `auditclient.Client.Append` sourced from
`usecase.Identity` if `Identity` grows an `IPAddress` field. Prefer the
metadata-key approach for consistency with the existing `Role` propagation
this CR's sibling (BE-SOL-002) just fixed.

## 3. Files to change

| File | Change |
|---|---|
| `backend-go/services/auth-service/migrations/0004_audit_outcome_and_ip.{up,down}.sql` | New migration |
| `backend-go/services/auth-service/internal/domain/audit.go` | `Outcome` type, `AuditEntry.Outcome`/`IPAddress`, `NewAuditEntry` signature change, `ErrInvalidOutcome` |
| `backend-go/services/auth-service/internal/adapter/postgres/audit_repository.go` | `Append`/`Query` carry the 2 new columns; `Query` gains `actor_id`/`action`/`outcome` filters |
| `backend-go/services/auth-service/internal/usecase/query_audit_log.go` | `QueryAuditLogInput` gains `ActorID`/`Action`/`Outcome` filters |
| `backend-go/proto/orca/auth/v1/auth.proto` | New `AppendAuditEntry` RPC + request message; `QueryAuditLogRequest`/`AuditEntry` gain the new fields |
| `backend-go/services/auth-service/internal/usecase/append_audit_entry.go` (new) | New usecase, no admin gate |
| `backend-go/services/auth-service/internal/adapter/grpc/server.go` | `AppendAuditEntry` handler; `toProtoAuditEntry` includes `Outcome`/`IpAddress` |
| `backend-go/common/auditclient/client.go` (new) | Shared best-effort audit-append client |
| `backend-go/services/project-service/internal/usecase/authorization.go` | Audit both branches of `requireProjectAccess`/`requireRepoAccess` |
| `backend-go/services/task-service/...` (verify exact file first) | Audit the grant-decision call site |
| `backend-go/services/annotation-service/...` (verify exact file first) | Audit the author-or-admin decision call site |
| `backend-go/services/infra-fleet-service/...` (verify exact file first) | Audit the SSH/connect decision call site |
| `backend-go/services/api-gateway/...` | Propagate client IP as `x-orca-client-ip` metadata alongside `MetadataRole` |

## 4. Out of scope

- Migrating `orca_audit_log` (legacy SQLite, `backend/`) — CR-RBAC-001's
  "Không thuộc phạm vi".
- Auditing pure-UI navigation actions — only permission-bearing decisions.
- A generic "audit middleware/interceptor" that auto-wraps every OPA call —
  the CR asks for 4 specific call sites; a generic interceptor is a larger,
  separate refactor (`common/grpcmw` is currently transport-only, adding
  business-semantic audit logic there would blur the layering
  `03-clean-architecture-guidelines.md` sets for `common/`).

## 5. Tests

- `domain/audit_test.go`: `NewAuditEntry` validates `Outcome`, defaults empty
  outcome to `allowed`.
- `postgres/audit_repository_test.go` (testcontainers, per this repo's
  standard `adapter/postgres/` test tier): round-trip `Outcome`/`IPAddress`;
  filter by each of `actor_id`/`action`/`outcome`.
- `usecase/append_audit_entry_test.go`: no admin gate required; rejects
  empty `tenant_id`/`action`.
- `usecase/query_audit_log_test.go`: extend with filter-combination cases.
- Integration test per service: a denied `requireProjectAccess` call results
  in exactly one `auditClient.Append(..., outcome: "denied", ...)` call
  (fake `auditclient` capturing the call, not a real cross-service RPC in
  the unit-test tier).

## 6. Impact analysis (gitnexus)

| Symbol | Direction | Risk | Impacted | Note |
|---|---|---|---|---|
| `AuditEntry` (`auth-service/internal/domain/audit.go:23`) | upstream | LOW | 14 (1 direct, 1 process `run` in `auth-service/cmd/server/main.go`) | Confirmed by `impact()` this pass — matches prior audit exactly. The `NewAuditEntry` signature change (adding `Outcome`/`IPAddress` params) is the one change that touches all direct callers; grep-confirmed only `auth-service`'s own usecases (`update_user_role.go` and similar) construct `AuditEntry` directly today — all in-repo, all updated in this same change. |
| `QueryAuditLog` (`auth-service/internal/usecase/query_audit_log.go:26`) | upstream | LOW | 3 (1 direct, 1 process `run`) | Confirmed by `impact()`. `QueryAuditLogInput`'s new optional filter fields are additive — existing callers (api-gateway's admin routes, if any) compile unchanged with zero-value filters meaning "no filter," per this codebase's established convention. |

Run `detect_changes({scope:"compare", base_ref:"main"})` after implementing,
particularly checking that `project-service`/`task-service`/
`annotation-service`'s existing OPA-gated processes still show 0 broken
steps — audit calls are additive (best-effort, non-blocking per §2.B) and
must never become a new failure mode for the underlying permission check.
