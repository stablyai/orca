# TASK-005: `wscompat` — register `ephemeralVm.attachWorkspace`/`suspendWorkspace`/`resumeWorkspace`/`cleanup`

**From Solution:** SOL-004 (Group 2a — `orca-server`-result lifecycle)
**Priority:** P2 — depends on TASK-003 (same file, `channels_ephemeral_vm.go`) and TASK-004 (the 4 new `infra-fleet-service` RPCs this wires to); this is the task that makes the two BUG-004-confirmed-live methods (`attachWorkspace`, `cleanup`) reachable
**Service:** `api-gateway`
**File:** `backend-go/services/api-gateway/internal/adapter/wscompat/channels_ephemeral_vm.go` (extend TASK-003's file)
**Depends on:** TASK-003, TASK-004
**Status:** `[x]` DONE — `go build`/`go vet`/`go test ./internal/adapter/wscompat/...` clean; 6 new tests added to `channels_ephemeral_vm_test.go` covering attachWorkspace's never-resolves-connection regression, suspend/resume's no-runtime-attached error path, cleanup's never-attached vs. attached branches, plus one addition beyond the task's own list. **Deviation:** proactively folded in TASK-006's documented follow-up — a `connection_type == "ssh"` guard (returning `INFRA_EPHEMERAL_VM_SSH_UNSUPPORTED`, a distinct, permanent code from `INFRA_EPHEMERAL_VM_UNSUPPORTED`) in `suspendWorkspace`/`resumeWorkspace`/`cleanup` before any relay attempt — TASK-006 explicitly says this branch belongs in TASK-004 or TASK-005 and should not be left for a later pass; landed here since this file already has the resolved runtime in hand. Added a regression test (`TestEphemeralVmSuspendWorkspace_SshConnectionType_RejectedBeforeRelay`) asserting the ssh-type runtime never reaches `SuspendEphemeralVmWorkspace`.

---

## Context

TASK-004 built the `infra-fleet-service` RPCs for the lifecycle group; this task resolves the two pieces those RPCs deliberately push up to the caller (per TASK-004's cross-service design note): the recipe's `suspend`/`resume`/`destroy` command text (only `git-gateway-service.ReadEphemeralVmRecipes`, TASK-001, can read it) and the `connectionId` a `workspaceId`/worktree id resolves to (`registerBrowserRelay`'s existing pattern, `channels_browser.go:56-64`).

## Changes to make

### Step 1 — helper: resolve a runtime + its recipe's command by id

```go
// added to channels_ephemeral_vm.go

// findEphemeralVmRuntime and its recipe command are resolved the same way
// TASK-003's getCleanupCommand handler already does (list runtimes, filter
// client-side — infra-fleet-service exposes no by-id/by-workspace RPC of
// its own beyond ListEphemeralVmRuntimes, see TASK-002/004's "plain
// Postgres read" scope).
func findEphemeralVmRuntimeByID(runtimes []*infrafleetv1.EphemeralVmRuntime, id string) *infrafleetv1.EphemeralVmRuntime {
	for _, rt := range runtimes {
		if rt.GetId() == id {
			return rt
		}
	}
	return nil
}

func findEphemeralVmRuntimeByWorkspaceID(runtimes []*infrafleetv1.EphemeralVmRuntime, workspaceID string) *infrafleetv1.EphemeralVmRuntime {
	for _, rt := range runtimes {
		if rt.GetWorkspaceId() == workspaceID {
			return rt
		}
	}
	return nil
}

// resolveEphemeralVmRecipeCommand fetches repoId's recipes and returns the
// named field ("suspend" | "resume" | "destroy") for recipeId, "" if the
// recipe/field is absent — command="" is a real, valid case (SuspendWorkspace/
// ResumeWorkspace/CleanupWorkspace's usecase-level "nothing to relay" branch,
// TASK-004), not an error.
func resolveEphemeralVmRecipeCommand(ctx context.Context, gitGateway gitgatewayv1.GitGatewayServiceClient, repoID, recipeID, field string) (string, error) {
	resp, err := gitGateway.ReadEphemeralVmRecipes(ctx, &gitgatewayv1.ReadEphemeralVmRecipesRequest{RepoId: repoID})
	if err != nil {
		return "", err
	}
	for _, rec := range resp.GetRecipes() {
		if rec.GetId() != recipeID {
			continue
		}
		switch field {
		case "suspend":
			return rec.GetSuspend(), nil
		case "resume":
			return rec.GetResume(), nil
		case "destroy":
			if rec.GetDestroyDisabled() {
				return "", nil
			}
			return rec.GetDestroy(), nil
		}
	}
	return "", nil
}

// resolveConnectionIDForWorktree mirrors registerBrowserRelay's worktree ->
// connectionId resolution (channels_browser.go:56-64, verbatim reference):
//
//	resolved, err := client.ResolveConnection(ctx, &infrafleetv1.ResolveConnectionRequest{WorktreeId: worktreeID})
//	if !resolved.GetConnected() { ... no dev server bound ... }
//	// use resolved.GetConnectionId(), NOT the dev server's own id
func resolveConnectionIDForWorktree(ctx context.Context, infra infrafleetv1.InfraFleetServiceClient, worktreeID string) (string, error) {
	if worktreeID == "" {
		return "", nil
	}
	resolved, err := infra.ResolveConnection(ctx, &infrafleetv1.ResolveConnectionRequest{WorktreeId: worktreeID})
	if err != nil {
		return "", err
	}
	if !resolved.GetConnected() {
		return "", nil
	}
	return resolved.GetConnectionId(), nil
}
```

### Step 2 — the 4 channels, appended to `registerEphemeralVmChannels` (TASK-003's function)

```go
	r.Register("ephemeralVm.attachWorkspace", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		in, err := decodeArg[struct {
			RuntimeID   string `json:"runtimeId"`
			WorkspaceID string `json:"workspaceId"`
		}](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		// No connection resolution needed — AttachWorkspace is pure
		// bookkeeping (TASK-004's correction to SOL-004's original sketch).
		resp, err := infra.AttachEphemeralVmWorkspace(rpcCtx, &infrafleetv1.AttachEphemeralVmWorkspaceRequest{
			RuntimeId: in.RuntimeID, WorkspaceId: in.WorkspaceID,
		})
		if err != nil {
			return nil, err
		}
		return toEphemeralVmRuntimeView(resp), nil
	})

	r.Register("ephemeralVm.suspendWorkspace", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		in, err := decodeArg[struct {
			WorkspaceID string `json:"workspaceId"`
		}](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()

		listResp, err := infra.ListEphemeralVmRuntimes(rpcCtx, &infrafleetv1.ListEphemeralVmRuntimesRequest{})
		if err != nil {
			return nil, err
		}
		runtime := findEphemeralVmRuntimeByWorkspaceID(listResp.GetRuntimes(), in.WorkspaceID)
		if runtime == nil {
			return nil, fmt.Errorf("EPHEMERAL_VM_NOT_ATTACHED: no runtime is attached to workspace %s", in.WorkspaceID)
		}
		command, err := resolveEphemeralVmRecipeCommand(rpcCtx, gitGateway, runtime.GetRepoId(), runtime.GetRecipeId(), "suspend")
		if err != nil {
			return nil, err
		}
		connectionID, err := resolveConnectionIDForWorktree(rpcCtx, infra, in.WorkspaceID)
		if err != nil {
			return nil, err
		}
		resp, err := infra.SuspendEphemeralVmWorkspace(rpcCtx, &infrafleetv1.SuspendEphemeralVmWorkspaceRequest{
			ConnectionId: connectionID, WorkspaceId: in.WorkspaceID, Command: command,
		})
		if err != nil {
			return nil, err
		}
		return toEphemeralVmRuntimeView(resp), nil
	})

	// ephemeralVm.resumeWorkspace is identical to suspendWorkspace above,
	// substituting the "resume" field and infra.ResumeEphemeralVmWorkspace.

	r.Register("ephemeralVm.cleanup", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		in, err := decodeArg[struct {
			RuntimeID string `json:"runtimeId"`
		}](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()

		listResp, err := infra.ListEphemeralVmRuntimes(rpcCtx, &infrafleetv1.ListEphemeralVmRuntimesRequest{})
		if err != nil {
			return nil, err
		}
		runtime := findEphemeralVmRuntimeByID(listResp.GetRuntimes(), in.RuntimeID)
		if runtime == nil {
			return nil, fmt.Errorf("EPHEMERAL_VM_RUNTIME_NOT_FOUND: %s", in.RuntimeID)
		}
		var command, connectionID string
		if runtime.GetWorkspaceId() != "" {
			// Only relay a destroy command if this runtime was ever attached
			// to a workspace — otherwise there is no worktree to resolve a
			// connection from (TASK-004's "open design note"); mark
			// destroyed locally with no agent call, matching desktop's own
			// always-progresses-to-a-terminal-state behavior.
			command, err = resolveEphemeralVmRecipeCommand(rpcCtx, gitGateway, runtime.GetRepoId(), runtime.GetRecipeId(), "destroy")
			if err != nil {
				return nil, err
			}
			connectionID, err = resolveConnectionIDForWorktree(rpcCtx, infra, runtime.GetWorkspaceId())
			if err != nil {
				return nil, err
			}
		}
		resp, err := infra.CleanupEphemeralVmWorkspace(rpcCtx, &infrafleetv1.CleanupEphemeralVmWorkspaceRequest{
			ConnectionId: connectionID, RuntimeId: in.RuntimeID, Command: command,
		})
		if err != nil {
			return nil, err
		}
		return toEphemeralVmRuntimeView(resp), nil
	})
```

Add the shared view helper next to `toEphemeralVmRecipeView` (TASK-003):

```go
func toEphemeralVmRuntimeView(rt *infrafleetv1.EphemeralVmRuntime) map[string]any {
	return map[string]any{
		"id": rt.GetId(), "repoId": rt.GetRepoId(), "recipeId": rt.GetRecipeId(),
		"connectionType": rt.GetConnectionType(), "status": rt.GetStatus(),
		"environmentId": rt.GetEnvironmentId(), "workspaceId": rt.GetWorkspaceId(), "lastError": rt.GetLastError(),
	}
}
```

(TASK-003's `registerEphemeralVmListRuntimes` can be simplified to call this same helper instead of duplicating the field list — small cleanup, do it in this task since this is where the duplication becomes visible.)

## Verify

```bash
cd backend-go/services/api-gateway
go build ./...
go vet ./...
go test ./internal/adapter/wscompat/... -run TestEphemeralVm -v
```

Extend `channels_ephemeral_vm_test.go` (TASK-003): `attachWorkspace` never calls `ResolveConnection` (pure bookkeeping — regression test for TASK-004's correction); `suspendWorkspace`/`resumeWorkspace` with no runtime attached to the given `workspaceId` return an error without calling `SuspendEphemeralVmWorkspace`; `cleanup` on a never-attached runtime (`workspaceId == ""`) calls `CleanupEphemeralVmWorkspace` with empty `connectionId`/`command` and does not call `ResolveConnection`.
