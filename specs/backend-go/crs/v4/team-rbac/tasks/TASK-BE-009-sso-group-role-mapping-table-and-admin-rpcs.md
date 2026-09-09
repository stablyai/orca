# TASK-BE-009: `sso_group_role_mapping` table + repository port + admin CRUD RPCs

> **Status: ✅ DONE — 2026-09-09**

### Kết quả thực tế

- Migration number: `0004_audit_outcome_and_ip` was already present on disk (TASK-BE-014 had already
  landed), so this task took the next free number: `0006_sso_group_role_mapping.{up,down}.sql`, exactly
  matching the schema quoted in this file.
- `domain.SsoGroupRoleMapping` (new, `internal/domain/sso_group_role_mapping.go`) + `NewSsoGroupRoleMapping`
  constructor, following `domain.SsoIdentity`'s invariant-validation pattern.
- `SsoGroupRoleMappingRepository` port added to `ports.go`: `Upsert(ctx, m) (m, error)` +
  `ListForProvider(ctx, tenantID, provider) ([]m, error)` — `Upsert` (not separate Create/Update) because
  the table's own `UNIQUE(tenant_id, provider, group_name)` constraint makes "update the mapping for this
  group" the only meaningful admin operation; a `postgres` adapter
  (`sso_group_role_mapping_repository.go`) implements both via `INSERT ... ON CONFLICT DO UPDATE`.
  `Repository` (the shared postgres struct) now satisfies this port automatically.
- `UpdateSsoGroupMapping`/`ListSsoGroupMapping` RPCs added to `auth.proto` (+ `SsoGroupRoleMapping`
  message), codegen run via `buf generate` — clean, no manual edits to generated files.
  `tenant_id` is a request field (matches `ListUsersRequest.tenant_id`'s existing convention — this
  service has no ambient tenant-from-context mechanism for admin-console RPCs).
  New usecases `update_sso_group_mapping.go`/`list_sso_group_mapping.go`, both gated by
  `requireAdminActor` — same pattern as every other admin usecase in this service. Wired into
  `internal/adapter/grpc/server.go` (`Server.UpdateSsoGroupMapping`/`Server.ListSsoGroupMapping` +
  `toProtoSsoGroupRoleMapping`) and `cmd/server/main.go`'s composition root (appended, not reordered, to
  `authgrpc.New(...)`'s existing positional argument list).
- `impact({target:"requireAdminActor", direction:"upstream", repo:"orca"})`: **15 existing direct
  callers**, 1 module (`Usecase`), 0 processes affected. The tool reports **risk: HIGH** purely because of
  that existing fan-out (>10 callers trips its heuristic) — `requireAdminActor`'s own body/signature was
  NOT modified, only 2 more call sites were added (now 17 total), so the actual blast radius of this
  change is unchanged for the 15 pre-existing callers. Per the repo's mandatory rule this HIGH reading is
  disclosed here rather than silently proceeding; verified safe by reading `requireAdminActor`'s body
  (pure function of `(ctx, users, opa)`, no side channel) before adding the 2 new call sites.
- Non-admin-denied tests: `TestUpdateSsoGroupMapping_DeniedWhenOPADecisionIsFalse`,
  `TestListSsoGroupMapping_DeniedWhenOPADecisionIsFalse`, plus allowed-path/upsert/filter tests in
  `update_sso_group_mapping_test.go`.
- `go build ./services/auth-service/...` and `go test ./services/auth-service/...` clean.
  `go build ./...` clean for `api-gateway` too (no route added there, not required by this task).
  `gofmt -l` clean on every changed file.

**Solution:** BE-SOL-003 | **CR:** CR-RBAC-003
**Depends on:** TASK-BE-003..006 (role model final — mapping targets 2-tier `user`/`admin` only).
Independent of TASK-BE-007/008 (different files); can run in parallel with them.

---

## Goal

Group→role mapping needs to be tenant-admin-editable via a real DB-backed table (not env/config), per the
CR's own preference for "quản lý qua 1 RPC" — consistent with `AccessPolicy`'s DB-backed, admin-editable
model. This task builds the table and its admin CRUD surface; TASK-BE-010 wires the actual
resolution logic into the login flow.

## What to do

1. New migration `backend-go/services/auth-service/migrations/000X_sso_group_role_mapping.{up,down}.sql`
   — **coordinate the migration number with TASK-BE-014's `000X_audit_outcome_and_ip`**: check
   `ls backend-go/services/auth-service/migrations/` at implementation time and take whichever number is
   free; if both land in the same window, whichever merges first takes the lower number.

```sql
CREATE TABLE auth.sso_group_role_mapping (
    id          UUID PRIMARY KEY,
    tenant_id   UUID NOT NULL,
    provider    TEXT NOT NULL,           -- domain.SsoProvider values
    group_name  TEXT NOT NULL,           -- e.g. "orca-admins" (OIDC) or "org:my-company" (GitHub)
    role        TEXT NOT NULL CHECK (role IN ('user', 'admin')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, provider, group_name)
);
ALTER TABLE auth.sso_group_role_mapping ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON auth.sso_group_role_mapping
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
```

2. New port `SsoGroupRoleMappingRepository` in
   `backend-go/services/auth-service/internal/usecase/ports.go` (`ListForProvider(ctx, tenantID,
   provider) ([]Row, error)` at minimum — shape to match whatever CRUD the RPCs below need) + a
   `postgres` adapter implementation.

3. New RPCs on `AuthService` (`backend-go/proto/orca/auth/v1/auth.proto`): `UpdateSsoGroupMapping`,
   `ListSsoGroupMapping` — gated by `requireAdminActor` (same pattern every other admin-console usecase in
   this service already uses).

4. New usecases `backend-go/services/auth-service/internal/usecase/update_sso_group_mapping.go`,
   `list_sso_group_mapping.go`.

5. `backend-go/services/auth-service/internal/adapter/grpc/server.go`: wire the 2 new RPC handlers.

## Acceptance Criteria

- [x] `auth.sso_group_role_mapping` table exists with RLS tenant isolation, per the schema above.
- [x] `SsoGroupRoleMappingRepository` port + postgres adapter implemented.
- [x] `UpdateSsoGroupMapping`/`ListSsoGroupMapping` RPCs added, admin-gated via `requireAdminActor`.
- [x] Non-admin caller is denied on both new RPCs (tested).
- [x] `go build ./...` / `go test ./...` clean for `auth-service`.

## gitnexus

Not run with numeric results in BE-SOL-003's pass (a wholly new table/port, no existing symbol modified).
Run `impact({target:"requireAdminActor", direction:"upstream"})` before wiring the two new usecases into
it, to confirm it's still safe to add 2 more callers (expected LOW — it's an established, widely-reused
gate in this service).

## Blocking

Blocks TASK-BE-010 (role resolution reads from this table).
