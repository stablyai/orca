# TASK-004: `infra-fleet-service` — `EphemeralVmRelay` usecase + proto RPCs for `attachWorkspace`/`suspendWorkspace`/`resumeWorkspace`/`cleanup`

**From Solution:** SOL-004 (Group 2a — `orca-server`-result lifecycle, `EmulatorRelay`-shaped)
**Priority:** P2 — depends on TASK-002's `ephemeral_vm_runtimes` table/repository; functionally inert (relays reach a real agent and get "method not found") until `agent/` adds a `vm.exec` handler, exactly like `EmulatorRelay` is inert until `agent/` adds `device.*` — see TASK-004's own "Status" note in that light. Ships anyway per the `EmulatorRelay` precedent (`emulator_relay.go:31-49`'s doc comment): plumbing now, self-heals the moment `agent/` catches up, zero further `backend-go` changes needed then.
**Service:** `infra-fleet-service`
**File:** `backend-go/proto/orca/infrafleet/v1/infrafleet.proto`, `backend-go/services/infra-fleet-service/internal/usecase/ephemeral_vm_relay.go` (new), `.../internal/adapter/postgres/ephemeral_vm_runtime_repository.go` (extend TASK-002's `List`), `.../internal/adapter/grpc/server.go`, `.../cmd/server/main.go`
**Depends on:** TASK-002
**Status:** `[x]` DONE — proto regenerated, `go build`/`go vet`/`go test ./internal/usecase/...` clean; 11 new tests in `ephemeral_vm_relay_test.go` cover the AttachWorkspace-never-calls-agent regression, no-connectionId FailedPrecondition, agent-method-not-found translation + error-status marking, and empty-command skip-the-relay branches for Suspend/Resume/Cleanup, as specified. As specified overall — the sketch's "no backend-host fallback" design and the AttachWorkspace correction both matched real source exactly, no further deviations found. Postgres write methods (`GetByWorkspaceID`/`UpdateStatus`) verified by inspection against `List`'s established pattern only, no live Postgres run (same as TASK-002's note).

---

## Context

BUG-004 confirms `ephemeralVm.attachWorkspace`/`cleanup` are called from the **live worktree-creation flow** (`ephemeral-vm-worktree-creation.ts`), making this the highest-user-impact task in the whole set. SOL-004 designs this group to reuse `EmulatorRelay`'s proven "resolve → relay → translate `method not found` into a typed, permanent `FailedPrecondition`" shape (`emulator_relay.go:79-93`'s `callAgent`) rather than re-litigating whether unblocked plumbing is safe to ship — it already shipped once, for a structurally identical problem (`missing-v1`'s `TASK-048`).

**Correction found against real desktop source, not SOL-004's approximate sketch:** SOL-004's own code sketch has `AttachWorkspace` call `vm.exec` with the recipe's `create` command. The real desktop implementation does not — `attachEphemeralVmWorkspace` (`desktop/src/main/ipc/ephemeral-vm-runtime-handlers.ts:69-77`, verbatim) is pure bookkeeping with **no shell exec at all**:

```ts
export function attachEphemeralVmWorkspace(args: {
  runtimeId: string
  workspaceId: string
}): EphemeralVmRuntimeRecord {
  return updateEphemeralVmRuntimeStatus(app.getPath('userData'), args.runtimeId, {
    status: 'running',
    workspaceId: args.workspaceId
  })
}
```

The real shell-exec of a recipe's `create` command happens in `ephemeralVm.provision` (streaming, `window.api`-only, explicitly out of scope for this whole bug per BUG-004's own "Not in scope" note) — by the time `attachWorkspace` is called, the runtime already exists and just needs to be bound to a workspace id. `suspendEphemeralVmWorkspace`/`resumeEphemeralVmWorkspace`/`cleanupEphemeralVmWorkspace` (`ephemeral-vm-runtime-handlers.ts:79-268`), by contrast, really do shell-exec the recipe's `suspend`/`resume`/`destroy` commands via `../ephemeral-vm-recipe-runner`'s `runEphemeralVmRecipeSuspend`/`Resume`/`Cleanup`. This task's design follows the **real** split: `AttachWorkspace` is Postgres-only (no agent relay, no new `agent/` dependency at all — it could ship in TASK-002 by this logic, but is kept here since it shares this file/RPC group); `SuspendWorkspace`/`ResumeWorkspace`/`CleanupWorkspace` are the 3 that actually need the new `vm.exec` agent handler.

**Cross-service design note:** the recipe's `suspend`/`resume`/`destroy` command text lives in the repo's `orca.yaml`, which only `git-gateway-service`'s `ReadEphemeralVmRecipes` (TASK-001) can read — but `infra-fleet-service` must not gain a dependency on `git-gateway-service` (the existing dependency direction is the other way: `git-gateway-service` already calls `infra-fleet-service`'s `ResolveConnection`; the reverse would risk a layering cycle). So the command string is resolved by the **`api-gateway` wscompat layer** (which already legitimately holds both clients, see TASK-005) and passed into these RPCs as an explicit field, rather than infra-fleet-service fetching it itself.

## Changes to make

### Step 1 — confirm `ConnectionResolver`'s existing `RepoPath` (the piece that makes this work without a `git-gateway-service` dependency)

`domain.Connection` (`internal/domain/connection.go:21-33`, verbatim current):

```go
type Connection struct {
	ID          string
	TenantID    string
	DevServerID string
	RepoPath    string
	WorktreeID  string
	Status         string // "established" | "degraded" | "closed"
	LastActivityAt *time.Time
}
```

`ResolveConnection`'s gRPC handler already returns it (`internal/adapter/grpc/server.go:188-205`, verbatim current, relevant excerpt):

```go
func (s *Server) ResolveConnection(ctx context.Context, req *infrafleetv1.ResolveConnectionRequest) (*infrafleetv1.ResolveConnectionResponse, error) {
	out, err := s.resolveConnection.Execute(ctx, usecase.ResolveConnectionInput{...})
	...
	resp := &infrafleetv1.ResolveConnectionResponse{Connected: out.Connected}
	if out.Connected {
		resp.DevServer = toProtoDevServer(out.DevServer)
		resp.RepoPath = out.RepoPath
		...
	}
	return resp, nil
}
```

So `EphemeralVmRelay` can resolve **both** the `DevServer` to relay to **and** the `RepoPath` the recipe command must run against from one `ResolveConnection` call — no new cross-service dependency needed.

### Step 2 — extend the migration/repository from TASK-002 with write methods

Add to `internal/adapter/postgres/ephemeral_vm_runtime_repository.go` (the `EphemeralVmRuntimeStore` TASK-002 created with only `List`):

```go
func (s *EphemeralVmRuntimeStore) GetByWorkspaceID(ctx context.Context, tenantID, workspaceID string) (domain.EphemeralVmRuntime, error) {
	const q = `
		SELECT id, repo_id, recipe_id, connection_type, status, COALESCE(environment_id, ''),
		       COALESCE(workspace_id, ''), COALESCE(last_error, ''), created_at, updated_at
		FROM infra.ephemeral_vm_runtimes
		WHERE tenant_id = $1 AND workspace_id = $2 AND status <> 'destroyed'`
	var r domain.EphemeralVmRuntime
	err := s.pool.QueryRow(ctx, q, tenantID, workspaceID).Scan(&r.ID, &r.RepoID, &r.RecipeID, &r.ConnectionType,
		&r.Status, &r.EnvironmentID, &r.WorkspaceID, &r.LastError, &r.CreatedAt, &r.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.EphemeralVmRuntime{}, domain.ErrEphemeralVmRuntimeNotFound
	}
	if err != nil {
		return domain.EphemeralVmRuntime{}, fmt.Errorf("postgres: get ephemeral vm runtime by workspace: %w", err)
	}
	return r, nil
}

// UpdateStatus applies a partial update — status is always set; the other
// fields are only touched when non-empty (workspaceID)/explicitly passed
// (lastError, which callers pass "" to clear on a successful transition).
func (s *EphemeralVmRuntimeStore) UpdateStatus(ctx context.Context, tenantID, id, status, workspaceID, lastError string) (domain.EphemeralVmRuntime, error) {
	const q = `
		UPDATE infra.ephemeral_vm_runtimes
		SET status = $3,
		    workspace_id = COALESCE(NULLIF($4, ''), workspace_id),
		    last_error = NULLIF($5, ''),
		    updated_at = now()
		WHERE tenant_id = $1 AND id = $2
		RETURNING id, repo_id, recipe_id, connection_type, status, COALESCE(environment_id, ''),
		          COALESCE(workspace_id, ''), COALESCE(last_error, ''), created_at, updated_at`
	var r domain.EphemeralVmRuntime
	err := s.pool.QueryRow(ctx, q, tenantID, id, status, workspaceID, lastError).Scan(&r.ID, &r.RepoID, &r.RecipeID,
		&r.ConnectionType, &r.Status, &r.EnvironmentID, &r.WorkspaceID, &r.LastError, &r.CreatedAt, &r.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.EphemeralVmRuntime{}, domain.ErrEphemeralVmRuntimeNotFound
	}
	if err != nil {
		return domain.EphemeralVmRuntime{}, fmt.Errorf("postgres: update ephemeral vm runtime status: %w", err)
	}
	return r, nil
}
```

(Add `domain.ErrEphemeralVmRuntimeNotFound = errors.New("domain: ephemeral vm runtime not found")` next to this service's other sentinel errors, and add `errors`/`pgx` imports if TASK-002's file didn't already need them.)

### Step 3 — `infrafleet.proto`: 4 new RPCs

Add after `ListEphemeralVmRuntimes` (TASK-002):

```protobuf
  // AttachEphemeralVmWorkspace is pure bookkeeping (no agent relay) — binds
  // an already-provisioned runtime to a workspace/worktree id. See
  // EphemeralVmRelay's doc comment for why this differs from SOL-004's own
  // sketch (which incorrectly modeled it as a create-command exec).
  rpc AttachEphemeralVmWorkspace(AttachEphemeralVmWorkspaceRequest) returns (EphemeralVmRuntime);
  // SuspendEphemeralVmWorkspace/ResumeEphemeralVmWorkspace/CleanupEphemeralVmWorkspace
  // relay `command` (the recipe's suspend/resume/destroy shell command,
  // resolved by api-gateway's wscompat layer via git-gateway-service's
  // ReadEphemeralVmRecipes — see TASK-005) to the repo's Dev Server via a
  // new agent-side `vm.exec` method that does not exist today. Every call
  // reaches a real agent and fails with a typed, permanent
  // INFRA_EPHEMERAL_VM_UNSUPPORTED FailedPrecondition until agent/ gains
  // one — see EmulatorRelay's identical, already-shipped pattern.
  rpc SuspendEphemeralVmWorkspace(SuspendEphemeralVmWorkspaceRequest) returns (EphemeralVmRuntime);
  rpc ResumeEphemeralVmWorkspace(ResumeEphemeralVmWorkspaceRequest) returns (EphemeralVmRuntime);
  rpc CleanupEphemeralVmWorkspace(CleanupEphemeralVmWorkspaceRequest) returns (EphemeralVmRuntime);

message AttachEphemeralVmWorkspaceRequest { string runtime_id = 1; string workspace_id = 2; }
message SuspendEphemeralVmWorkspaceRequest { string connection_id = 1; string workspace_id = 2; string command = 3; }
message ResumeEphemeralVmWorkspaceRequest { string connection_id = 1; string workspace_id = 2; string command = 3; }
message CleanupEphemeralVmWorkspaceRequest { string connection_id = 1; string runtime_id = 2; string command = 3; }
```

(`EphemeralVmRuntime` message already exists from TASK-002.)

### Step 4 — `EphemeralVmRelay` usecase, mirroring `EmulatorRelay`'s shape

`EmulatorRelay`'s `resolveDevServer`/`callAgent` (`emulator_relay.go:59-93`, verbatim current, already quoted in TASK-002/SOL-004) is the pattern; this type additionally needs `RepoPath` out of the same `ResolveConnection` call (Step 1) and a runtime-repository dependency TASK-002 didn't need:

```go
// internal/usecase/ephemeral_vm_relay.go
package usecase

import (
	"context"
	"errors"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/common/tenant"
	"github.com/stablyai/orca-go/services/infra-fleet-service/internal/domain"
)

type EphemeralVmRuntimeRepository interface {
	List(ctx context.Context, tenantID string) ([]domain.EphemeralVmRuntime, error)
	GetByWorkspaceID(ctx context.Context, tenantID, workspaceID string) (domain.EphemeralVmRuntime, error)
	UpdateStatus(ctx context.Context, tenantID, id, status, workspaceID, lastError string) (domain.EphemeralVmRuntime, error)
}

// EphemeralVmRelay implements ephemeralVm.attachWorkspace/suspendWorkspace/
// resumeWorkspace/cleanup (SOL-004 Group 2a). Same "no backend-host
// fallback, connectionId required" rule as EmulatorRelay — running a
// repo-authored shell command on the shared backend-go host is the same
// class of blast-radius problem browser/emulator driving already excludes.
type EphemeralVmRelay struct {
	resolver ConnectionResolver
	agent    DevServerAgentClient
	runtimes EphemeralVmRuntimeRepository
}

func NewEphemeralVmRelay(resolver ConnectionResolver, agent DevServerAgentClient, runtimes EphemeralVmRuntimeRepository) *EphemeralVmRelay {
	return &EphemeralVmRelay{resolver: resolver, agent: agent, runtimes: runtimes}
}

func (uc *EphemeralVmRelay) resolveDevServerAndRepoPath(ctx context.Context, tenantID, connectionID string) (domain.DevServer, string, error) {
	if connectionID == "" {
		return domain.DevServer{}, "", apperrors.New(apperrors.KindFailedPrecondition, "INFRA_EPHEMERAL_VM_NO_CONNECTION", "ephemeral vm lifecycle operations require an active dev server connection — there is no local/backend-host fallback", nil)
	}
	connected, devServer, conn, err := uc.resolver.ResolveConnection(ctx, tenantID, connectionID)
	if err != nil {
		return domain.DevServer{}, "", apperrors.New(apperrors.KindInternal, "INFRA_RESOLVE_FAILED", "failed to resolve connection", err)
	}
	if !connected {
		return domain.DevServer{}, "", apperrors.New(apperrors.KindFailedPrecondition, "INFRA_EPHEMERAL_VM_NO_CONNECTION", "no dev server is bound to this connection", nil)
	}
	return devServer, conn.RepoPath, nil
}

// callAgent mirrors EmulatorRelay.callAgent exactly (emulator_relay.go:79-93)
// — real agent "method not found" -> typed, permanent FailedPrecondition.
func (uc *EphemeralVmRelay) callAgent(ctx context.Context, devServer domain.DevServer, method string, params map[string]any) (map[string]any, error) {
	result, err := uc.agent.Exec(ctx, devServer, method, params)
	if err != nil {
		if errors.Is(err, domain.ErrAgentMethodNotFound) {
			return nil, apperrors.New(apperrors.KindFailedPrecondition, "INFRA_EPHEMERAL_VM_UNSUPPORTED",
				"this dev server's agent build does not support ephemeral vm commands ("+method+") — see specs/backend-go/bugs/missing-v3/solutions/SOL-004-ephemeralvm-channels.md", err)
		}
		return nil, apperrors.New(apperrors.KindInternal, "INFRA_AGENT_EXEC_FAILED", "failed to relay "+method+" to dev server agent", err)
	}
	return result, nil
}

// AttachWorkspace is pure bookkeeping — see this file's package doc comment
// for why this differs from SOL-004's original create-command-exec sketch.
func (uc *EphemeralVmRelay) AttachWorkspace(ctx context.Context, runtimeID, workspaceID string) (domain.EphemeralVmRuntime, error) {
	tenantID, err := tenant.RequireTenantID(ctx)
	if err != nil {
		return domain.EphemeralVmRuntime{}, apperrors.New(apperrors.KindUnauthenticated, "INFRA_NO_TENANT", "no tenant in request context", err)
	}
	return uc.runtimes.UpdateStatus(ctx, tenantID, runtimeID, "active", workspaceID, "")
}

// SuspendWorkspace relays command (the recipe's `suspend` field, resolved
// by the caller — see TASK-005) via vm.exec, then persists the transition.
func (uc *EphemeralVmRelay) SuspendWorkspace(ctx context.Context, connectionID, workspaceID, command string) (domain.EphemeralVmRuntime, error) {
	tenantID, err := tenant.RequireTenantID(ctx)
	if err != nil {
		return domain.EphemeralVmRuntime{}, apperrors.New(apperrors.KindUnauthenticated, "INFRA_NO_TENANT", "no tenant in request context", err)
	}
	runtime, err := uc.runtimes.GetByWorkspaceID(ctx, tenantID, workspaceID)
	if err != nil {
		return domain.EphemeralVmRuntime{}, apperrors.New(apperrors.KindNotFound, "INFRA_EPHEMERAL_VM_RUNTIME_NOT_FOUND", "no runtime is attached to this workspace", err)
	}
	if command == "" {
		return uc.runtimes.UpdateStatus(ctx, tenantID, runtime.ID, "suspended", "", "")
	}
	devServer, repoPath, err := uc.resolveDevServerAndRepoPath(ctx, tenantID, connectionID)
	if err != nil {
		return domain.EphemeralVmRuntime{}, err
	}
	_, err = uc.callAgent(ctx, devServer, "vm.exec", map[string]any{"repoPath": repoPath, "command": command, "phase": "suspend"})
	if err != nil {
		_, _ = uc.runtimes.UpdateStatus(ctx, tenantID, runtime.ID, "error", "", err.Error())
		return domain.EphemeralVmRuntime{}, err
	}
	return uc.runtimes.UpdateStatus(ctx, tenantID, runtime.ID, "suspended", "", "")
}

// ResumeWorkspace mirrors SuspendWorkspace exactly, target status "active".
func (uc *EphemeralVmRelay) ResumeWorkspace(ctx context.Context, connectionID, workspaceID, command string) (domain.EphemeralVmRuntime, error) {
	tenantID, err := tenant.RequireTenantID(ctx)
	if err != nil {
		return domain.EphemeralVmRuntime{}, apperrors.New(apperrors.KindUnauthenticated, "INFRA_NO_TENANT", "no tenant in request context", err)
	}
	runtime, err := uc.runtimes.GetByWorkspaceID(ctx, tenantID, workspaceID)
	if err != nil {
		return domain.EphemeralVmRuntime{}, apperrors.New(apperrors.KindNotFound, "INFRA_EPHEMERAL_VM_RUNTIME_NOT_FOUND", "no runtime is attached to this workspace", err)
	}
	if command != "" {
		devServer, repoPath, err := uc.resolveDevServerAndRepoPath(ctx, tenantID, connectionID)
		if err != nil {
			return domain.EphemeralVmRuntime{}, err
		}
		if _, err := uc.callAgent(ctx, devServer, "vm.exec", map[string]any{"repoPath": repoPath, "command": command, "phase": "resume"}); err != nil {
			_, _ = uc.runtimes.UpdateStatus(ctx, tenantID, runtime.ID, "error", "", err.Error())
			return domain.EphemeralVmRuntime{}, err
		}
	}
	return uc.runtimes.UpdateStatus(ctx, tenantID, runtime.ID, "active", "", "")
}

// CleanupWorkspace runs the recipe's destroy command (if any — command=""
// means the recipe has no destroy step or destroyDisabled is set, mirroring
// desktop's own "cleanupDisabled" short-circuit) then marks the runtime
// destroyed regardless of whether a command ran, matching desktop's
// cleanupEphemeralVmWorkspace always progressing the record to a terminal
// state even when there's nothing to execute.
func (uc *EphemeralVmRelay) CleanupWorkspace(ctx context.Context, connectionID, runtimeID, command string) (domain.EphemeralVmRuntime, error) {
	tenantID, err := tenant.RequireTenantID(ctx)
	if err != nil {
		return domain.EphemeralVmRuntime{}, apperrors.New(apperrors.KindUnauthenticated, "INFRA_NO_TENANT", "no tenant in request context", err)
	}
	if command != "" {
		devServer, repoPath, err := uc.resolveDevServerAndRepoPath(ctx, tenantID, connectionID)
		if err != nil {
			return domain.EphemeralVmRuntime{}, err
		}
		if _, err := uc.callAgent(ctx, devServer, "vm.exec", map[string]any{"repoPath": repoPath, "command": command, "phase": "destroy"}); err != nil {
			_, _ = uc.runtimes.UpdateStatus(ctx, tenantID, runtimeID, "error", "", err.Error())
			return domain.EphemeralVmRuntime{}, err
		}
	}
	return uc.runtimes.UpdateStatus(ctx, tenantID, runtimeID, "destroyed", "", "")
}
```

**Open design note, not resolved by this task:** unlike `Suspend`/`Resume` (looked up by `workspaceID`), `Cleanup` takes `runtimeID` directly and never resolves a `connectionID` from it internally — the caller (TASK-005's wscompat handler) must supply `connectionID` explicitly, which means it must already know which connection/worktree owns that runtime. If the runtime was never attached to a workspace (`workspace_id` still NULL — e.g. cleaning up a failed provisioning attempt), there is no worktree to resolve a connection from at all; TASK-005 should treat that case as "nothing to relay, mark destroyed locally," mirroring desktop's own behavior of resolving cleanup via `repoId` (always present) rather than `workspaceId` (may never have been set).

### Step 5 — gRPC server + `main.go` wiring (mirrors `emulatorRelayUC`, `main.go:201`/`:249`, and `AttachEmulatorSession`, `server_emulator_host.go:39-48`)

```go
// main.go, next to: emulatorRelayUC := usecase.NewEmulatorRelay(repo, agentClient)
ephemeralVmRelayUC := usecase.NewEphemeralVmRelay(repo, agentClient, ephemeralVmRuntimeStore)
```

Append `ephemeralVmRelayUC` to `infragrpc.New(...)`'s argument list and `Server`'s field list (same append-at-the-end convention as TASK-002), then add:

```go
func (s *Server) AttachEphemeralVmWorkspace(ctx context.Context, req *infrafleetv1.AttachEphemeralVmWorkspaceRequest) (*infrafleetv1.EphemeralVmRuntime, error) {
	runtime, err := s.ephemeralVmRelay.AttachWorkspace(ctx, req.GetRuntimeId(), req.GetWorkspaceId())
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return toProtoEphemeralVmRuntime(runtime), nil
}

func (s *Server) SuspendEphemeralVmWorkspace(ctx context.Context, req *infrafleetv1.SuspendEphemeralVmWorkspaceRequest) (*infrafleetv1.EphemeralVmRuntime, error) {
	runtime, err := s.ephemeralVmRelay.SuspendWorkspace(ctx, req.GetConnectionId(), req.GetWorkspaceId(), req.GetCommand())
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return toProtoEphemeralVmRuntime(runtime), nil
}

// ResumeEphemeralVmWorkspace / CleanupEphemeralVmWorkspace follow identically.

func toProtoEphemeralVmRuntime(r domain.EphemeralVmRuntime) *infrafleetv1.EphemeralVmRuntime {
	return &infrafleetv1.EphemeralVmRuntime{
		Id: r.ID, RepoId: r.RepoID, RecipeId: r.RecipeID, ConnectionType: r.ConnectionType,
		Status: r.Status, EnvironmentId: r.EnvironmentID, WorkspaceId: r.WorkspaceID, LastError: r.LastError,
		CreatedAt: timestamppb.New(r.CreatedAt), UpdatedAt: timestamppb.New(r.UpdatedAt),
	}
}
```

## Verify

```bash
cd backend-go/services/infra-fleet-service
go build ./...
go vet ./...
go test ./internal/usecase/... -run TestEphemeralVmRelay -v
```

New test file `ephemeral_vm_relay_test.go`: no `connectionId` on `Suspend`/`Resume`/`Cleanup` with a non-empty `command` → `KindFailedPrecondition` (mirrors `TestEmulatorRelay_ListDevices_NoConnectionID_FailsPrecondition`); real agent "method not found" → `INFRA_EPHEMERAL_VM_UNSUPPORTED`; `AttachWorkspace` never calls `agent.Exec` (pure bookkeeping — this is the regression test for this task's own correction to SOL-004's sketch); `Suspend`/`Resume`/`Cleanup` with `command=""` skip the relay entirely and still transition status.
