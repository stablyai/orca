# TASK-003: `wscompat` — register `ephemeralVm.listRecipes`/`listRecipeCatalog`/`doctor`/`getCleanupCommand`/`listRuntimes`

**From Solution:** SOL-004 (Group 1 — recipe/runtime reads)
**Priority:** P1 — depends on TASK-001 (usecase types) and TASK-002 (gRPC clients); this is the task that actually makes 5 of the 9 `ephemeralVm.*` channels reachable from a `backend-go`-backed runtime target
**Service:** `api-gateway`
**File:** `backend-go/services/api-gateway/internal/adapter/wscompat/channels_ephemeral_vm.go` (new), `backend-go/services/api-gateway/internal/adapter/wscompat/channels.go` (`RegisterRealChannels` wiring)
**Depends on:** TASK-001, TASK-002
**Status:** `[x]` DONE — `go build`/`go vet`/`go test ./internal/adapter/wscompat/...` clean; 6 new tests in `channels_ephemeral_vm_test.go` (one per channel plus the N+1 `listRecipeCatalog` assertion) all pass. **Deviations:** (1) confirmed the real client parameter names in `RegisterRealChannels` are `gitClient`/`projectClient`/`infraFleetClient`, not `gitGatewayClient`/`projectClient` as the task guessed. (2) `channels.go` (the shared hot file) was edited concurrently by another task between my Read and my Edit — my one-line insertion (`registerEphemeralVmChannels(r, gitClient, projectClient, infraFleetClient)` after `registerBrowserChannels`) applied cleanly with no conflict. (3) Pre-added `findEphemeralVmRuntimeByID`/`toEphemeralVmRuntimeView` helpers into this same file in this pass (not deferred to TASK-005) since I implemented TASK-005 immediately afterward in the same session — no functional difference from the task's intended split.

---

## Context

BUG-004's table lists these 5 methods as having "no backing RPC on any service" for a remote/backend-go target — `ephemeralVm.listRecipes`, `listRecipeCatalog`, `doctor`, `listRuntimes`, `getCleanupCommand`. TASK-001/002 built the backing gRPC RPCs; this task wires them into `wscompat` so the frontend's existing hybrid routing client (`frontend/src/renderer/src/runtime/runtime-ephemeral-vm-client.ts`, unchanged — it already calls these exact channel names whenever the active runtime target is `{kind: 'environment'}`) actually reaches them.

## Changes to make

### Step 1 — confirm the exact patterns being reused

`registerBrowserRelay`, the single representative "decode args → `AttachIdentity` → `rpcTimeout` → call → translate" skeleton (`channels_browser.go:39-83`, verbatim current — see relevant excerpt):

```go
func registerBrowserRelay(r *Registry, client infrafleetv1.InfraFleetServiceClient, channel, agentMethod string) {
	r.Register(channel, func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		...
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		resolved, err := client.ResolveConnection(ctx, &infrafleetv1.ResolveConnectionRequest{WorktreeId: worktreeID})
		...
	})
}
```

`decodeArg` (`registry.go:259-268`, verbatim current):

```go
func decodeArg[T any](args []json.RawMessage, index int) (T, error) {
	var v T
	if index >= len(args) {
		return v, fmt.Errorf("missing arg[%d]", index)
	}
	if err := json.Unmarshal(args[index], &v); err != nil {
		return v, fmt.Errorf("decoding arg[%d]: %w", index, err)
	}
	return v, nil
}
```

`rpcTimeout` (`channels.go:102`, verbatim current): `const rpcTimeout = 8 * time.Second`

`registerOrcaProjectSharingChannels`'s `ListProjects` → per-project `ListSourceProjects` N+1 loop (`channels_orca_project_sharing.go:66-99`, verbatim current, relevant excerpt) is the pattern `listRecipeCatalog` reuses, for the reason explained in Step 3 below:

```go
r.Register("orcaProjects.list", func(ctx context.Context, id Identity, _ []json.RawMessage) (any, error) {
	ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
	rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
	defer cancel()
	listResp, err := client.ListProjects(rpcCtx, &projectv1.ListProjectsRequest{TenantId: id.TenantID})
	...
	for _, p := range listResp.GetProjects() {
		sourcesResp, err := client.ListSourceProjects(rpcCtx, &projectv1.ListSourceProjectsRequest{ContainerProjectId: p.GetId()})
		...
	}
})
```

### Step 2 — `ephemeralVm.listRecipes` / `doctor` / `getCleanupCommand` (repo-scoped, single `gitGateway.ReadEphemeralVmRecipes` call)

```go
// backend-go/services/api-gateway/internal/adapter/wscompat/channels_ephemeral_vm.go
// Package wscompat — ephemeralVm.* channels (SOL-004 Group 1: recipe/runtime
// reads only — attach/suspend/resume/cleanup are TASK-005; the ssh-result
// lifecycle is permanently blocked, see TASK-006).
package wscompat

import (
	"context"
	"encoding/json"

	gitgatewayv1 "github.com/stablyai/orca-go/proto/gen/go/orca/gitgateway/v1"
	infrafleetv1 "github.com/stablyai/orca-go/proto/gen/go/orca/infrafleet/v1"
	projectv1 "github.com/stablyai/orca-go/proto/gen/go/orca/project/v1"

	gatewaygrpc "github.com/stablyai/orca-go/services/api-gateway/internal/adapter/grpc"
	"github.com/stablyai/orca-go/services/api-gateway/internal/usecase"
)

type ephemeralVmRecipeView struct {
	ID              string `json:"id"`
	Name            string `json:"name"`
	Description     string `json:"description,omitempty"`
	Create          string `json:"create"`
	Suspend         string `json:"suspend,omitempty"`
	Resume          string `json:"resume,omitempty"`
	Destroy         string `json:"destroy,omitempty"`
	DestroyDisabled bool   `json:"destroyDisabled,omitempty"`
}

func toEphemeralVmRecipeView(r *gitgatewayv1.EphemeralVmRecipe) ephemeralVmRecipeView {
	return ephemeralVmRecipeView{
		ID: r.GetId(), Name: r.GetName(), Description: r.GetDescription(),
		Create: r.GetCreate(), Suspend: r.GetSuspend(), Resume: r.GetResume(),
		Destroy: r.GetDestroy(), DestroyDisabled: r.GetDestroyDisabled(),
	}
}

func registerEphemeralVmChannels(r *Registry, gitGateway gitgatewayv1.GitGatewayServiceClient, project projectv1.ProjectServiceClient, infra infrafleetv1.InfraFleetServiceClient) {
	r.Register("ephemeralVm.listRecipes", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		in, err := decodeArg[struct {
			RepoID string `json:"repoId"`
		}](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		resp, err := gitGateway.ReadEphemeralVmRecipes(rpcCtx, &gitgatewayv1.ReadEphemeralVmRecipesRequest{RepoId: in.RepoID})
		if err != nil {
			return nil, err
		}
		recipes := make([]ephemeralVmRecipeView, 0, len(resp.GetRecipes()))
		for _, rec := range resp.GetRecipes() {
			recipes = append(recipes, toEphemeralVmRecipeView(rec))
		}
		return map[string]any{
			"repoPath": resp.GetRepoPath(), "recipes": recipes, "diagnostics": resp.GetDiagnostics(),
		}, nil
	})

	r.Register("ephemeralVm.doctor", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		in, err := decodeArg[struct {
			RepoID   string `json:"repoId"`
			RecipeID string `json:"recipeId"`
		}](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		resp, err := gitGateway.ReadEphemeralVmRecipes(rpcCtx, &gitgatewayv1.ReadEphemeralVmRecipesRequest{RepoId: in.RepoID})
		if err != nil {
			return nil, err
		}
		for _, rec := range resp.GetRecipes() {
			if rec.GetId() != in.RecipeID {
				continue
			}
			if rec.GetDestroyDisabled() || rec.GetDestroy() == "" {
				return map[string]any{"recipeId": in.RecipeID, "repoPath": resp.GetRepoPath(), "ok": true, "checks": []map[string]any{
					{"id": "create-command-present", "status": "pass", "message": "create command is configured"},
					{"id": "destroy-command-present", "status": "warn", "message": "no destroy command configured — cleanup will require manual teardown"},
				}}, nil
			}
			return map[string]any{"recipeId": in.RecipeID, "repoPath": resp.GetRepoPath(), "ok": true, "checks": []map[string]any{
				{"id": "create-command-present", "status": "pass", "message": "create command is configured"},
			}}, nil
		}
		return map[string]any{"recipeId": in.RecipeID, "repoPath": resp.GetRepoPath(), "ok": false, "checks": []map[string]any{
			{"id": "recipe-found", "status": "fail", "message": "recipe " + in.RecipeID + " not found in orca.yaml"},
		}}, nil
	})

	r.Register("ephemeralVm.getCleanupCommand", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		in, err := decodeArg[struct {
			RuntimeID string `json:"runtimeId"`
		}](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		// Resolve the runtime row first (need its repoId+recipeId to look up
		// the recipe's destroy command) — same infra client Step 4 below uses.
		listResp, err := infra.ListEphemeralVmRuntimes(rpcCtx, &infrafleetv1.ListEphemeralVmRuntimesRequest{})
		if err != nil {
			return nil, err
		}
		var runtime *infrafleetv1.EphemeralVmRuntime
		for _, rt := range listResp.GetRuntimes() {
			if rt.GetId() == in.RuntimeID {
				runtime = rt
				break
			}
		}
		if runtime == nil {
			return map[string]any{"runtimeId": in.RuntimeID, "command": nil, "payloadJson": "", "cleanupDisabled": true, "message": "runtime not found"}, nil
		}
		recipesResp, err := gitGateway.ReadEphemeralVmRecipes(rpcCtx, &gitgatewayv1.ReadEphemeralVmRecipesRequest{RepoId: runtime.GetRepoId()})
		if err != nil {
			return nil, err
		}
		for _, rec := range recipesResp.GetRecipes() {
			if rec.GetId() != runtime.GetRecipeId() {
				continue
			}
			if rec.GetDestroyDisabled() || rec.GetDestroy() == "" {
				return map[string]any{"runtimeId": in.RuntimeID, "command": nil, "payloadJson": "", "cleanupDisabled": true}, nil
			}
			return map[string]any{"runtimeId": in.RuntimeID, "command": rec.GetDestroy(), "payloadJson": "", "cleanupDisabled": false}, nil
		}
		return map[string]any{"runtimeId": in.RuntimeID, "command": nil, "payloadJson": "", "cleanupDisabled": true, "message": "recipe not found"}, nil
	})

	registerEphemeralVmListRecipeCatalog(r, gitGateway, project)
	registerEphemeralVmListRuntimes(r, infra)
}
```

### Step 3 — `ephemeralVm.listRecipeCatalog` (no args — every repo across every project the caller belongs to)

`listRuntimeEphemeralVmRecipeCatalog` (`runtime-ephemeral-vm-client.ts:25-33`, verbatim current) calls this channel with **zero** arguments — unlike `listRecipes`/`doctor`, there is no `repoId` to scope by. `Identity` (`registry.go:19-28`, verbatim current) carries only `TenantID`/`UserID`/`Role` — no project scoping either. The only faithful reading of "list the catalog across all repos" with no id supplied is **every project the tenant/caller can see** — reusing `registerOrcaProjectSharingChannels`'s exact `ListProjects` → per-project N+1 loop shape (Step 1), extended one level further to `ListRepos` → per-repo `ReadEphemeralVmRecipes`:

```go
func registerEphemeralVmListRecipeCatalog(r *Registry, gitGateway gitgatewayv1.GitGatewayServiceClient, project projectv1.ProjectServiceClient) {
	r.Register("ephemeralVm.listRecipeCatalog", func(ctx context.Context, id Identity, _ []json.RawMessage) (any, error) {
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()

		projectsResp, err := project.ListProjects(rpcCtx, &projectv1.ListProjectsRequest{TenantId: id.TenantID})
		if err != nil {
			return nil, err
		}
		type catalogEntry struct {
			RepoID      string                  `json:"repoId"`
			RepoName    string                  `json:"repoName"`
			RepoPath    string                  `json:"repoPath"`
			Recipes     []ephemeralVmRecipeView `json:"recipes"`
			Diagnostics []string                `json:"diagnostics"`
		}
		var entries []catalogEntry
		for _, p := range projectsResp.GetProjects() {
			reposResp, err := project.ListRepos(rpcCtx, &projectv1.ListReposRequest{ProjectId: p.GetId()})
			if err != nil {
				return nil, err
			}
			for _, repo := range reposResp.GetRepos() {
				recipesResp, err := gitGateway.ReadEphemeralVmRecipes(rpcCtx, &gitgatewayv1.ReadEphemeralVmRecipesRequest{RepoId: repo.GetId()})
				if err != nil {
					return nil, err
				}
				if len(recipesResp.GetRecipes()) == 0 && len(recipesResp.GetDiagnostics()) == 0 {
					continue // mirrors desktop's listRecipeCatalog filter — skip repos with nothing to show
				}
				recipes := make([]ephemeralVmRecipeView, 0, len(recipesResp.GetRecipes()))
				for _, rec := range recipesResp.GetRecipes() {
					recipes = append(recipes, toEphemeralVmRecipeView(rec))
				}
				entries = append(entries, catalogEntry{
					RepoID: repo.GetId(), RepoName: repo.GetDisplayName(), RepoPath: recipesResp.GetRepoPath(),
					Recipes: recipes, Diagnostics: recipesResp.GetDiagnostics(),
				})
			}
		}
		return entries, nil
	})
}
```

**Open scaling note, not a blocker:** this is an N+1-of-N+1 call chain (`ListProjects` × `ListRepos` × `ReadEphemeralVmRecipes`) — acceptable for now on the same reasoning `registerOrcaProjectSharingChannels`'s own comment gives ("project counts per caller are small"), but worth revisiting if a tenant with many large projects makes this channel slow; not addressed in this task.

### Step 4 — `ephemeralVm.listRuntimes` (plain Postgres read, no relay)

```go
func registerEphemeralVmListRuntimes(r *Registry, infra infrafleetv1.InfraFleetServiceClient) {
	r.Register("ephemeralVm.listRuntimes", func(ctx context.Context, id Identity, _ []json.RawMessage) (any, error) {
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		resp, err := infra.ListEphemeralVmRuntimes(rpcCtx, &infrafleetv1.ListEphemeralVmRuntimesRequest{})
		if err != nil {
			return nil, err
		}
		out := make([]map[string]any, 0, len(resp.GetRuntimes()))
		for _, rt := range resp.GetRuntimes() {
			out = append(out, map[string]any{
				"id": rt.GetId(), "repoId": rt.GetRepoId(), "recipeId": rt.GetRecipeId(),
				"connectionType": rt.GetConnectionType(), "status": rt.GetStatus(),
				"environmentId": rt.GetEnvironmentId(), "workspaceId": rt.GetWorkspaceId(), "lastError": rt.GetLastError(),
			})
		}
		return out, nil
	})
}
```

### Step 5 — wire into `RegisterRealChannels`

`channels.go:151` currently has: `registerBrowserChannels(r, infraFleetClient)`. Add immediately after:

```go
registerEphemeralVmChannels(r, gitGatewayClient, projectClient, infraFleetClient)
```

(Confirm the exact existing local variable names for the git-gateway and project gRPC clients in `RegisterRealChannels`'s parameter list — `channels.go:107`'s signature — before wiring; they are almost certainly named `gitGatewayClient`/`projectClient` given `channels_git.go`/`channels_orca_project_sharing.go` already use clients of these types, but confirm rather than assume.)

## Verify

```bash
cd backend-go/services/api-gateway
go build ./...
go vet ./...
go test ./internal/adapter/wscompat/... -run TestEphemeralVm -v
```

New test file `channels_ephemeral_vm_test.go` (this task should add it, not just wire the channels): one test per channel with fake `GitGatewayServiceClient`/`ProjectServiceClient`/`InfraFleetServiceClient`, asserting the identity/timeout wiring convention `channels_browser_test.go`'s `fakeBrowserRelayClient` pattern already establishes, plus `listRecipeCatalog`'s N+1 loop calling `ListRepos` once per project returned by `ListProjects`.
