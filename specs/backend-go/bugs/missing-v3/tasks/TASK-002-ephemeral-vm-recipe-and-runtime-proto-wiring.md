# TASK-002: Proto + gRPC wiring for `ReadEphemeralVmRecipes` (git-gateway-service) and `ListEphemeralVmRuntimes` (infra-fleet-service, new table)

**From Solution:** SOL-004 (Group 1 — recipe/runtime reads)
**Priority:** P1 — depends on TASK-001's usecase types; blocks TASK-003 (wscompat wiring needs these gRPC clients to exist)
**Service:** `git-gateway-service` + `infra-fleet-service`
**File:** `backend-go/proto/orca/gitgateway/v1/gitgateway.proto`, `backend-go/services/git-gateway-service/internal/adapter/grpc/server.go`, `backend-go/services/git-gateway-service/cmd/server/main.go`; `backend-go/proto/orca/infrafleet/v1/infrafleet.proto`, `backend-go/services/infra-fleet-service/migrations/0013_ephemeral_vm_runtimes.{up,down}.sql`, `.../internal/adapter/postgres/ephemeral_vm_runtime_repository.go` (new), `.../internal/usecase/list_ephemeral_vm_runtimes.go` (new), `.../internal/adapter/grpc/server.go`, `.../cmd/server/main.go`
**Depends on:** TASK-001
**Status:** `[x]` DONE — proto regenerated via `buf generate`, both services build/vet/test clean. **Deviations:** (1) the sketch's inline `message` blocks inside the `InfraFleetService` service body are invalid proto syntax — messages were placed after the service block instead, next to `DevServer`. (2) `git-gateway-service`'s gRPC server file's `New(...)` constructor already required updating `server_test.go`'s own `newTestServerWithResolver` call site (not mentioned in the task) to add the new positional arg — done. (3) `infra-fleet-service`'s new `ListEphemeralVmRuntimes`/`toProtoEphemeralVmRuntime` handler was put in a new `server_ephemeral_vm.go` file (mirroring the existing `server_emulator_host.go` split), not inline in `server.go`, since TASK-004 adds 4 more handlers to this same group. Postgres repository has no live-DB test (none exists for the sibling `BrowserProfileStore` either); its `List` query was verified by close inspection against `BrowserProfileStore.List`'s pattern, not run against a live Postgres.

---

## Context

TASK-001 built the usecase layer for reading recipes; this task exposes it over gRPC (`git-gateway-service`) and adds the second Group 1 read — `listRuntimes` — which needs a brand-new Postgres table in `infra-fleet-service` (the durable, shared "which ephemeral VM runtimes exist and what state are they in" record SOL-004 and the prior TS-era design doc both identify as a real gap independent of the SSH-client blocker). This table is also `EphemeralVmRelay`'s (TASK-004) storage, so its schema is designed here to serve both read and write paths, not just this task's own read.

## Changes to make

### Step 1 — `gitgateway.proto`: add `ReadEphemeralVmRecipes`

Current service block ends its repo-scoped group with (verbatim, `gitgateway.proto:92-95`):

```protobuf
  rpc CheckHooks(CheckHooksRequest) returns (CheckHooksResponse);     // repo.hooksCheck
  rpc ReadIssueCommand(ReadIssueCommandRequest) returns (ReadIssueCommandResponse);
  rpc WriteIssueCommand(WriteIssueCommandRequest) returns (google.protobuf.Empty);
  rpc ScanSetupScriptImports(ScanSetupScriptImportsRequest) returns (ScanSetupScriptImportsResponse);
```

Add immediately after (this file has an existing header note that it's edited concurrently by other work groups adding RPCs to this same service block — expect a manual merge, per that note; add this RPC as an independent, non-overlapping insertion):

```protobuf
  // ReadEphemeralVmRecipes reads orca.yaml's environmentRecipes section off
  // repoId's owning host (Group 1 of SOL-004 — no new agent capability,
  // reuses the already-existing fs.readFile relay via GitExecutor.ReadFile).
  // See specs/backend-go/bugs/missing-v3/solutions/SOL-004-ephemeralvm-channels.md.
  rpc ReadEphemeralVmRecipes(ReadEphemeralVmRecipesRequest) returns (ReadEphemeralVmRecipesResponse);
```

Add the messages near `CheckHooksRequest`/`CheckHooksResponse` (`gitgateway.proto:621-622`, verbatim current):

```protobuf
message CheckHooksRequest { string worktree_id = 1; string repo_id = 2; }
message CheckHooksResponse { repeated string installed_hooks = 1; bool orca_hooks_current = 2; }
```

New messages, same style (`repo_id`-only, no `worktree_id` — `ReadEphemeralVmRecipes` is called from repo-scoped contexts, same as `CheckHooks`):

```protobuf
message ReadEphemeralVmRecipesRequest { string repo_id = 1; }
message ReadEphemeralVmRecipesResponse {
  string repo_path = 1;
  repeated EphemeralVmRecipe recipes = 2;
  repeated string diagnostics = 3;
}
message EphemeralVmRecipe {
  string id = 1;
  string name = 2;
  string description = 3;
  string create = 4;
  string suspend = 5;
  string resume = 6;
  string destroy = 7;
  bool destroy_disabled = 8;
}
```

Regenerate stubs (check the actual codegen command in this repo's tooling first):

```bash
cd backend-go
buf generate   # or: make proto-gen — confirm the real target name in backend-go/Makefile before running
```

### Step 2 — `git-gateway-service`'s gRPC server: wire the new RPC

`Server` struct (`internal/adapter/grpc/server.go:24-50` excerpt, verbatim) already has one field per usecase (e.g. `checkHooks *usecase.CheckHooks` at line 74) and a large positional `New(...)` constructor (`checkHooks *usecase.CheckHooks,` is one of its params, line 146; `checkHooks: checkHooks,` in the returned `&Server{...}` literal, line 211). Add, following that exact pattern:

- New field: `readEphemeralVmRecipes *usecase.ReadEphemeralVmRecipes` (append after `checkHooks`, not mid-list, to keep the merge described in Step 1 conflict-free)
- New constructor param, appended at the end of `New(...)`'s parameter list (this constructor already has 60+ positional params — appending at the end, not inserting mid-list, is this file's own established convention for the least-conflict-prone addition)
- New field assignment in the returned `&Server{...}` literal
- New method, next to `CheckHooks`/`ReadIssueCommand` (`server.go:656-670`, verbatim current, for shape reference):

```go
func (s *Server) CheckHooks(ctx context.Context, req *gitgatewayv1.CheckHooksRequest) (*gitgatewayv1.CheckHooksResponse, error) {
	result, err := s.checkHooks.Execute(ctx, usecase.CheckHooksInput{RepoID: req.GetRepoId()})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &gitgatewayv1.CheckHooksResponse{InstalledHooks: result.InstalledHooks, OrcaHooksCurrent: result.OrcaHooksCurrent}, nil
}
```

New method to add:

```go
func (s *Server) ReadEphemeralVmRecipes(ctx context.Context, req *gitgatewayv1.ReadEphemeralVmRecipesRequest) (*gitgatewayv1.ReadEphemeralVmRecipesResponse, error) {
	result, err := s.readEphemeralVmRecipes.Execute(ctx, usecase.ReadEphemeralVmRecipesInput{RepoID: req.GetRepoId()})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	recipes := make([]*gitgatewayv1.EphemeralVmRecipe, 0, len(result.Recipes))
	for _, r := range result.Recipes {
		recipes = append(recipes, &gitgatewayv1.EphemeralVmRecipe{
			Id: r.ID, Name: r.Name, Description: r.Description,
			Create: r.Create, Suspend: r.Suspend, Resume: r.Resume,
			Destroy: r.Destroy, DestroyDisabled: r.DestroyDisabled,
		})
	}
	return &gitgatewayv1.ReadEphemeralVmRecipesResponse{
		RepoPath: result.RepoPath, Recipes: recipes, Diagnostics: result.Diagnostics,
	}, nil
}
```

### Step 3 — `git-gateway-service`'s `cmd/server/main.go`: wire the usecase

Current wiring for `CheckHooks` (`main.go:177`, verbatim): `checkHooksUC := usecase.NewCheckHooks(devServerReachability, projectClient, local, relay)`, passed into `gitgatewaygrpc.New(...)` at the position shown at `main.go:215`'s `..., checkHooksUC, ...`.

Add, next to it:

```go
readEphemeralVmRecipesUC := usecase.NewReadEphemeralVmRecipes(devServerReachability, projectClient, local, relay)
```

...and append `readEphemeralVmRecipesUC` at the **end** of the `gitgatewaygrpc.New(...)` call's argument list (matching Step 2's field-ordering convention), and at the end of `Server`'s constructor signature in Step 2.

### Step 4 — `infrafleet.proto`: add `ListEphemeralVmRuntimes`

Add near the end of the `InfraFleetService` service block (after the existing `GetHostCapabilities` RPC, in the same "additive, doesn't touch existing RPCs" style the emulator block used):

```protobuf
  // ListEphemeralVmRuntimes is a plain tenant-scoped Postgres read (no
  // relay) of every non-destroyed ephemeral_vm_runtimes row — SOL-004
  // Group 1's second read. Written to by EphemeralVmRelay (TASK-004).
  rpc ListEphemeralVmRuntimes(ListEphemeralVmRuntimesRequest) returns (ListEphemeralVmRuntimesResponse);

message ListEphemeralVmRuntimesRequest {}
message ListEphemeralVmRuntimesResponse { repeated EphemeralVmRuntime runtimes = 1; }
message EphemeralVmRuntime {
  string id = 1;
  string repo_id = 2;
  string recipe_id = 3;
  string connection_type = 4;   // "orca-server" | "ssh" | "" (unset until create/resume's result is parsed)
  string status = 5;            // "provisioning" | "active" | "suspended" | "error" | "destroyed"
  string environment_id = 6;    // set once an orca-server-type recipe's pairing succeeds
  string workspace_id = 7;      // set by AttachWorkspace (TASK-004); empty until attached
  string last_error = 8;
  google.protobuf.Timestamp created_at = 9;
  google.protobuf.Timestamp updated_at = 10;
}
```

(`ListEphemeralVmRuntimesRequest` carries no fields — tenant scoping comes from the caller's gRPC metadata via `tenant.RequireTenantID`, the same convention `EmulatorRelay`'s methods use.)

Regenerate stubs the same way as Step 1.

### Step 5 — new migration

```sql
-- backend-go/services/infra-fleet-service/migrations/0013_ephemeral_vm_runtimes.up.sql
CREATE TABLE infra.ephemeral_vm_runtimes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  repo_id         UUID NOT NULL,              -- logical FK -> project-service's repo, not enforced here (cross-service, per database-per-service rule)
  recipe_id       TEXT NOT NULL,               -- matches OrcaVmRecipe.id from orca.yaml, not a Postgres FK (recipes are repo-authored, not backend-owned rows)
  connection_type TEXT NOT NULL DEFAULT '' CHECK (connection_type IN ('', 'orca-server', 'ssh')),
  status          TEXT NOT NULL DEFAULT 'provisioning' CHECK (status IN
                     ('provisioning', 'active', 'suspended', 'error', 'destroyed')),
  environment_id  TEXT,                        -- set once an orca-server-type recipe's pairing succeeds; NULL for ssh-type (permanently blocked, see TASK-006)
  workspace_id    TEXT,                        -- set by AttachWorkspace (TASK-004); NULL until a workspace/worktree is attached
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_ephemeral_vm_runtimes_tenant ON infra.ephemeral_vm_runtimes (tenant_id) WHERE status <> 'destroyed';
CREATE INDEX idx_ephemeral_vm_runtimes_repo ON infra.ephemeral_vm_runtimes (repo_id) WHERE status <> 'destroyed';
```

```sql
-- backend-go/services/infra-fleet-service/migrations/0013_ephemeral_vm_runtimes.down.sql
DROP TABLE IF EXISTS infra.ephemeral_vm_runtimes;
```

(Schema matches `infra.browser_profiles`'s tenant-scoped pattern, `migrations/0006_browser_profiles.up.sql` — verbatim current: `CREATE TABLE infra.browser_profiles (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL, dev_server_id UUID NOT NULL REFERENCES infra.dev_servers(id), name TEXT NOT NULL, source_browser TEXT, is_default BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMPTZ NOT NULL DEFAULT now()); CREATE INDEX idx_browser_profiles_tenant_dev_server ON infra.browser_profiles (tenant_id, dev_server_id);` — same "own small store, own migration, its own struct rather than the giant `Repository`" shape as `BrowserProfileStore`, applied below.)

### Step 6 — new repository (mirrors `BrowserProfileStore` exactly)

`BrowserProfileStore` (`internal/adapter/postgres/browser_profile_repository.go:22-44`, verbatim current, for shape reference):

```go
type BrowserProfileStore struct {
	pool *pgxpool.Pool
}

func NewBrowserProfileStore(pool *pgxpool.Pool) *BrowserProfileStore {
	return &BrowserProfileStore{pool: pool}
}

func (s *BrowserProfileStore) List(ctx context.Context, tenantID, devServerID string) ([]domain.BrowserProfile, error) {
	const q = `
		SELECT id, tenant_id, dev_server_id, name, source_browser, is_default, created_at
		FROM infra.browser_profiles
		WHERE tenant_id = $1 AND dev_server_id = $2
		ORDER BY created_at`
	rows, err := s.pool.Query(ctx, q, tenantID, devServerID)
	...
}
```

New file (this task adds only `List` — TASK-004 adds `Create`/`UpdateStatus`/`Get` to this same struct, since it owns the same table):

```go
// backend-go/services/infra-fleet-service/internal/adapter/postgres/ephemeral_vm_runtime_repository.go
package postgres

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/stablyai/orca-go/services/infra-fleet-service/internal/domain"
)

// EphemeralVmRuntimeStore implements usecase.EphemeralVmRuntimeRepository —
// a separate struct + table from the giant Repository, same reason
// BrowserProfileStore is separate (see that type's doc comment).
type EphemeralVmRuntimeStore struct {
	pool *pgxpool.Pool
}

func NewEphemeralVmRuntimeStore(pool *pgxpool.Pool) *EphemeralVmRuntimeStore {
	return &EphemeralVmRuntimeStore{pool: pool}
}

// List returns every non-destroyed runtime for tenantID — backs
// ListEphemeralVmRuntimes (TASK-002); Create/UpdateStatus (TASK-004) write
// to the same table.
func (s *EphemeralVmRuntimeStore) List(ctx context.Context, tenantID string) ([]domain.EphemeralVmRuntime, error) {
	const q = `
		SELECT id, repo_id, recipe_id, connection_type, status, COALESCE(environment_id, ''),
		       COALESCE(workspace_id, ''), COALESCE(last_error, ''), created_at, updated_at
		FROM infra.ephemeral_vm_runtimes
		WHERE tenant_id = $1 AND status <> 'destroyed'
		ORDER BY created_at`
	rows, err := s.pool.Query(ctx, q, tenantID)
	if err != nil {
		return nil, fmt.Errorf("postgres: listing ephemeral vm runtimes: %w", err)
	}
	defer rows.Close()

	var out []domain.EphemeralVmRuntime
	for rows.Next() {
		var r domain.EphemeralVmRuntime
		if err := rows.Scan(&r.ID, &r.RepoID, &r.RecipeID, &r.ConnectionType, &r.Status,
			&r.EnvironmentID, &r.WorkspaceID, &r.LastError, &r.CreatedAt, &r.UpdatedAt); err != nil {
			return nil, fmt.Errorf("postgres: scanning ephemeral vm runtime row: %w", err)
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

var _ = pgx.ErrNoRows // referenced by TASK-004's Get/UpdateStatus additions to this file
```

Add the `domain.EphemeralVmRuntime` struct to `internal/domain/` alongside the other `infra-fleet-service` domain types (`ID, RepoID, RecipeID, ConnectionType, Status, EnvironmentID, WorkspaceID, LastError string; CreatedAt, UpdatedAt time.Time`).

### Step 7 — usecase + gRPC + `main.go` wiring (mirrors `ListBrowserProfiles`/`emulatorRelayUC` wiring exactly)

```go
// internal/usecase/list_ephemeral_vm_runtimes.go
package usecase

import (
	"context"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/common/tenant"
	"github.com/stablyai/orca-go/services/infra-fleet-service/internal/domain"
)

type EphemeralVmRuntimeRepository interface {
	List(ctx context.Context, tenantID string) ([]domain.EphemeralVmRuntime, error)
}

type ListEphemeralVmRuntimes struct {
	runtimes EphemeralVmRuntimeRepository
}

func NewListEphemeralVmRuntimes(runtimes EphemeralVmRuntimeRepository) *ListEphemeralVmRuntimes {
	return &ListEphemeralVmRuntimes{runtimes: runtimes}
}

func (uc *ListEphemeralVmRuntimes) Execute(ctx context.Context) ([]domain.EphemeralVmRuntime, error) {
	tenantID, err := tenant.RequireTenantID(ctx)
	if err != nil {
		return nil, apperrors.New(apperrors.KindUnauthenticated, "INFRA_NO_TENANT", "no tenant in request context", err)
	}
	return uc.runtimes.List(ctx, tenantID)
}
```

`main.go`: add `ephemeralVmRuntimeStore := infrapostgres.NewEphemeralVmRuntimeStore(pool)` next to `browserProfileStore := infrapostgres.NewBrowserProfileStore(pool)` (`main.go:95`), and `listEphemeralVmRuntimesUC := usecase.NewListEphemeralVmRuntimes(ephemeralVmRuntimeStore)` next to `listBrowserProfilesUC := usecase.NewListBrowserProfiles(browserProfileStore)` (`main.go:194`); append both the new field and constructor param to `infragrpc.New(...)` the same append-at-the-end way as Step 2/3, and add the gRPC method (mirrors `ListEmulatorDevices`, `server_emulator_host.go:19-29`):

```go
func (s *Server) ListEphemeralVmRuntimes(ctx context.Context, _ *infrafleetv1.ListEphemeralVmRuntimesRequest) (*infrafleetv1.ListEphemeralVmRuntimesResponse, error) {
	runtimes, err := s.listEphemeralVmRuntimes.Execute(ctx)
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	out := make([]*infrafleetv1.EphemeralVmRuntime, 0, len(runtimes))
	for _, r := range runtimes {
		out = append(out, &infrafleetv1.EphemeralVmRuntime{
			Id: r.ID, RepoId: r.RepoID, RecipeId: r.RecipeID, ConnectionType: r.ConnectionType,
			Status: r.Status, EnvironmentId: r.EnvironmentID, WorkspaceId: r.WorkspaceID, LastError: r.LastError,
			CreatedAt: timestamppb.New(r.CreatedAt), UpdatedAt: timestamppb.New(r.UpdatedAt),
		})
	}
	return &infrafleetv1.ListEphemeralVmRuntimesResponse{Runtimes: out}, nil
}
```

## Verify

```bash
cd backend-go
buf generate   # confirm real codegen target in backend-go/Makefile first

cd services/git-gateway-service
go build ./... && go vet ./...
go test ./internal/usecase/... ./internal/adapter/grpc/... -count=1

cd ../infra-fleet-service
go build ./... && go vet ./...
go test ./internal/usecase/... ./internal/adapter/postgres/... ./internal/adapter/grpc/... -count=1
```
