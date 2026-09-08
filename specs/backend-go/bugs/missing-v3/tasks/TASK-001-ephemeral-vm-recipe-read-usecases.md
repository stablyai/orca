# TASK-001: `git-gateway-service` — `ReadEphemeralVmRecipes`/`DoctorEphemeralVmRecipe`/`GetEphemeralVmCleanupCommand` usecases

**From Solution:** SOL-004 (Group 1 — recipe/runtime reads)
**Priority:** P1 — no dependency on any other task in this set; the proto/wscompat wiring in TASK-002/TASK-003 depend on this task's usecase types existing first
**Service:** `git-gateway-service`
**File:** `backend-go/services/git-gateway-service/internal/usecase/read_ephemeral_vm_recipes.go` (new), `backend-go/services/git-gateway-service/internal/domain/domain.go` (new `EphemeralVmRecipe` type), `backend-go/services/git-gateway-service/go.mod`/`go.sum` (new YAML dependency)
**Depends on:** none
**Status:** `[x]` DONE — implemented, `go build`/`go vet`/`go test ./internal/usecase/...` all clean. **Deviation from sketch:** the task's premise that `GitExecutor` declares `ReadFile` (`ports.go:301`) does not hold against current source — `ReadFile` is declared on `FilesystemExecutor`, not `GitExecutor`; `localgit.Executor` (this service's `GitExecutor` "local") has no `ReadFile` method at all (only `localfs.Executor`/`RelayExecutor` implement it). Adapted by giving `ReadEphemeralVmRecipes` `FilesystemExecutor` deps instead of `GitExecutor`, and adding a new `dispatchFilesystemExecutorForRepo` helper in `ports.go` (mirrors `dispatchExecutorForRepo` exactly, parameterized on `FilesystemExecutor`) since no repo-scoped (as opposed to worktree-scoped) filesystem dispatch existed. `main.go` wiring (TASK-002/003's job) should pass `localFS`/`relayFS`, not `local`/`relay`.

---

## Context

BUG-004 found all 9 `ephemeralVm.*` channels unreachable for a `backend-go`-backed runtime target. SOL-004 splits the fix into three groups; this task builds Group 1's usecase layer — recipe listing, the per-recipe doctor check, and the cleanup-command preview — none of which need any new `agent/` capability, because `git-gateway-service` already has both the repo→host dispatch (`dispatchExecutorForRepo`) and the file-read primitive (`GitExecutor.ReadFile`) this needs. This mirrors `CheckHooks`'s existing shape almost exactly — same 4 constructor dependencies, same `GetRepo` → `dispatchExecutorForRepo` → single named read flow.

## Changes to make

### Step 1 — confirm the exact pattern being mirrored (`check_hooks.go`, current, verbatim)

```go
// backend-go/services/git-gateway-service/internal/usecase/check_hooks.go
package usecase

import (
	"context"

	"github.com/stablyai/orca-go/common/apperrors"
)

type CheckHooksInput struct {
	RepoID string
}

type CheckHooksResult struct {
	InstalledHooks   []string
	OrcaHooksCurrent bool
}

type CheckHooks struct {
	reachability DevServerReachability
	projects     ProjectClient
	local        GitExecutor
	relay        GitExecutor
}

func NewCheckHooks(reachability DevServerReachability, projects ProjectClient, local, relay GitExecutor) *CheckHooks {
	return &CheckHooks{reachability: reachability, projects: projects, local: local, relay: relay}
}

func (uc *CheckHooks) Execute(ctx context.Context, in CheckHooksInput) (CheckHooksResult, error) {
	if in.RepoID == "" {
		return CheckHooksResult{}, apperrors.New(apperrors.KindInvalidArgument, "GITGATEWAY_MISSING_REPO_ID", "repo_id is required", nil)
	}
	repo, err := uc.projects.GetRepo(ctx, in.RepoID)
	if err != nil {
		return CheckHooksResult{}, apperrors.New(apperrors.KindNotFound, "WORKTREE_REPO_NOT_FOUND", "repo does not exist", err)
	}
	ctx, executor, repoPath, err := dispatchExecutorForRepo(ctx, uc.reachability, uc.local, uc.relay, repo)
	if err != nil {
		return CheckHooksResult{}, apperrors.New(apperrors.KindInternal, "GITGATEWAY_RESOLVE_FAILED", "failed to resolve repo's owning host", err)
	}
	installedHooks, orcaHooksCurrent, err := executor.CheckHooks(ctx, repoPath)
	if err != nil {
		return CheckHooksResult{}, apperrors.New(apperrors.KindInternal, "GITGATEWAY_CHECK_HOOKS_FAILED", "failed to check git hooks", err)
	}
	return CheckHooksResult{InstalledHooks: installedHooks, OrcaHooksCurrent: orcaHooksCurrent}, nil
}
```

`dispatchExecutorForRepo` (`ports.go:458-470`, current, verbatim):

```go
func dispatchExecutorForRepo(ctx context.Context, reachability DevServerReachability, local, relay GitExecutor, repo domain.RepoInfo) (context.Context, GitExecutor, string, error) {
	if repo.DevServerID == "" {
		return ctx, local, repo.URL, nil
	}
	reachable, err := reachability.IsReachable(ctx, repo.DevServerID)
	if err != nil {
		return ctx, nil, "", err
	}
	if reachable {
		return WithDevServerID(ctx, repo.DevServerID), relay, repo.URL, nil
	}
	return ctx, local, repo.URL, nil
}
```

`GitExecutor` already declares (`ports.go:301`, current, verbatim — **no interface change needed**):

```go
	ReadFile(ctx context.Context, repoPath, relPath string) ([]byte, error)
```

Both `RelayExecutor.ReadFile` (relays `fs.readFile` to the agent — see `agent/src/relay/agent-rpc-dispatch-fs.ts:31`, already live) and the local `localgit.Executor.ReadFile` already implement this method for real (added under TASK-049 in `missing-v1`) — this task adds **zero** new agent-side or executor-side capability, only a new usecase that calls the existing method with `"orca.yaml"`.

`ProjectClient` (`ports.go:353-357`, current, verbatim):

```go
type ProjectClient interface {
	GetRepo(ctx context.Context, repoID string) (domain.RepoInfo, error)
	RecordWorktreeCreated(ctx context.Context, projectID, repoID, path, branch string, lineage domain.WorktreeLineageCapture) (domain.WorktreeRecord, error)
	RecordWorktreeRemoved(ctx context.Context, worktreeID string) error
}
```

### Step 2 — add the `EphemeralVmRecipe` domain type

`backend-go/services/git-gateway-service/internal/domain/domain.go`, add near `RepoInfo` (`domain.go:253-259`):

```go
// EphemeralVmRecipe mirrors frontend/src/shared/types.ts's OrcaVmRecipe — a
// repo-authored orca.yaml `environmentRecipes[]` entry naming the shell
// commands that provision/suspend/resume/destroy a per-workspace ephemeral
// VM/container. This service never runs these commands itself (Group 1 is
// read-only) — see usecase.EphemeralVmRelay (TASK-004) for the lifecycle
// half that does.
type EphemeralVmRecipe struct {
	ID              string
	Name            string
	Description     string
	Create          string
	Suspend         string
	Resume          string
	Destroy         string
	DestroyDisabled bool
}
```

### Step 3 — add the YAML dependency

`orca.yaml`'s `environmentRecipes` section has no existing Go parser anywhere in `backend-go` (confirmed: no `gopkg.in/yaml`/`sigs.k8s.io/yaml` import in any `backend-go/services/*/go.mod` today). Add `gopkg.in/yaml.v3` to `git-gateway-service`'s `go.mod`:

```bash
cd backend-go/services/git-gateway-service
go get gopkg.in/yaml.v3
```

### Step 4 — new usecase file

```go
// backend-go/services/git-gateway-service/internal/usecase/read_ephemeral_vm_recipes.go
package usecase

import (
	"context"

	"gopkg.in/yaml.v3"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/services/git-gateway-service/internal/domain"
)

type ReadEphemeralVmRecipesInput struct {
	RepoID string
}

type ReadEphemeralVmRecipesResult struct {
	RepoPath    string
	Recipes     []domain.EphemeralVmRecipe
	Diagnostics []string
}

// ReadEphemeralVmRecipes resolves repoID's owning host and reads its
// orca.yaml's environmentRecipes section — Group 1 of SOL-004
// (specs/backend-go/bugs/missing-v3/solutions/SOL-004-ephemeralvm-channels.md).
// Mirrors CheckHooks exactly: same 4 constructor deps, same
// GetRepo -> dispatchExecutorForRepo -> single named read shape. Unlike
// CheckHooks, the read is a raw file (GitExecutor.ReadFile, already-existing
// method, no new agent capability) rather than a directory listing, and a
// malformed orca.yaml produces Diagnostics, not an error — matching
// desktop's loadHooks' own tolerant parsing (a broken environmentRecipes
// block must not block reading repo/worktree state elsewhere).
type ReadEphemeralVmRecipes struct {
	reachability DevServerReachability
	projects     ProjectClient
	local        GitExecutor
	relay        GitExecutor
}

func NewReadEphemeralVmRecipes(reachability DevServerReachability, projects ProjectClient, local, relay GitExecutor) *ReadEphemeralVmRecipes {
	return &ReadEphemeralVmRecipes{reachability: reachability, projects: projects, local: local, relay: relay}
}

func (uc *ReadEphemeralVmRecipes) Execute(ctx context.Context, in ReadEphemeralVmRecipesInput) (ReadEphemeralVmRecipesResult, error) {
	if in.RepoID == "" {
		return ReadEphemeralVmRecipesResult{}, apperrors.New(apperrors.KindInvalidArgument, "GITGATEWAY_MISSING_REPO_ID", "repo_id is required", nil)
	}
	repo, err := uc.projects.GetRepo(ctx, in.RepoID)
	if err != nil {
		return ReadEphemeralVmRecipesResult{}, apperrors.New(apperrors.KindNotFound, "WORKTREE_REPO_NOT_FOUND", "repo does not exist", err)
	}
	ctx, executor, repoPath, err := dispatchExecutorForRepo(ctx, uc.reachability, uc.local, uc.relay, repo)
	if err != nil {
		return ReadEphemeralVmRecipesResult{}, apperrors.New(apperrors.KindInternal, "GITGATEWAY_RESOLVE_FAILED", "failed to resolve repo's owning host", err)
	}
	raw, err := executor.ReadFile(ctx, repoPath, "orca.yaml")
	if err != nil {
		// orca.yaml simply not existing is the common case (most repos have
		// no environmentRecipes) — report zero recipes, not an error,
		// mirroring loadHooks' existsSync guard on the desktop side.
		return ReadEphemeralVmRecipesResult{RepoPath: repoPath}, nil
	}
	return parseEnvironmentRecipes(repoPath, raw), nil
}

// orcaYamlFile is the subset of orca.yaml this usecase cares about — every
// other top-level key (hooks, etc.) is ignored by yaml.v3's decode-into-
// partial-struct behavior, so this stays additive-safe against unrelated
// orca.yaml schema changes.
type orcaYamlFile struct {
	EnvironmentRecipes []orcaYamlRecipe `yaml:"environmentRecipes"`
}

type orcaYamlRecipe struct {
	ID              string `yaml:"id"`
	Name            string `yaml:"name"`
	Description     string `yaml:"description"`
	Create          string `yaml:"create"`
	Suspend         string `yaml:"suspend"`
	Resume          string `yaml:"resume"`
	Destroy         string `yaml:"destroy"`
	DestroyDisabled bool   `yaml:"destroyDisabled"`
}

// parseEnvironmentRecipes never returns an error — a malformed orca.yaml (or
// a malformed individual recipe entry, e.g. missing id/create) becomes a
// Diagnostics string, matching desktop's loadHooks/environmentRecipeDiagnostics
// convention (frontend/src/shared/types.ts's OrcaVmRecipeDiagnostic) so one
// broken recipe block doesn't fail every other recipe/hooks read for the repo.
func parseEnvironmentRecipes(repoPath string, raw []byte) ReadEphemeralVmRecipesResult {
	var file orcaYamlFile
	if err := yaml.Unmarshal(raw, &file); err != nil {
		return ReadEphemeralVmRecipesResult{
			RepoPath:    repoPath,
			Diagnostics: []string{"orca.yaml is not valid YAML: " + err.Error()},
		}
	}
	var recipes []domain.EphemeralVmRecipe
	var diagnostics []string
	for i, r := range file.EnvironmentRecipes {
		if r.ID == "" || r.Create == "" {
			diagnostics = append(diagnostics, "environmentRecipes["+itoa(i)+"]: id and create are required, skipping")
			continue
		}
		recipes = append(recipes, domain.EphemeralVmRecipe{
			ID: r.ID, Name: r.Name, Description: r.Description,
			Create: r.Create, Suspend: r.Suspend, Resume: r.Resume,
			Destroy: r.Destroy, DestroyDisabled: r.DestroyDisabled,
		})
	}
	return ReadEphemeralVmRecipesResult{RepoPath: repoPath, Recipes: recipes, Diagnostics: diagnostics}
}
```

(`itoa` — use `strconv.Itoa`, add to the `import` block.)

### Step 5 — `DoctorEphemeralVmRecipe` and `GetEphemeralVmCleanupCommand` (pure functions over an already-fetched recipe)

Per SOL-004: both are pure functions with no additional I/O once `ReadEphemeralVmRecipes` has already run — port them into the **same file**, not separate usecase structs, since neither needs `ProjectClient`/`DevServerReachability`/`GitExecutor` at all:

```go
type EphemeralVmRecipeDoctorCheck struct {
	ID          string
	Status      string // "pass" | "warn" | "fail" — mirrors EphemeralVmRecipeDoctorCheckStatus
	Message     string
	Remediation string
}

type EphemeralVmRecipeDoctorResult struct {
	RecipeID string
	RepoPath string
	OK       bool
	Checks   []EphemeralVmRecipeDoctorCheck
}

// DoctorEphemeralVmRecipe runs a minimal, backend-safe subset of desktop's
// doctorEphemeralVmRecipe (desktop/src/main/ipc/ephemeral-vm.ts:61-73 calls
// it with localExecutionSupported: true; here it is always false — a
// backend-go pod is never itself the execution target for a recipe, see
// EphemeralVmRelay's "no backend-host fallback" rule in TASK-004). Checks
// that recipeID exists in recipes and that create is non-empty; does NOT
// attempt command-path/PATH checks (desktop's checkCommandPath assumes a
// local filesystem this service's pod does not have — see this method's
// own "known gap" note below).
func DoctorEphemeralVmRecipe(repoPath, recipeID string, recipes []domain.EphemeralVmRecipe) EphemeralVmRecipeDoctorResult {
	for _, r := range recipes {
		if r.ID != recipeID {
			continue
		}
		checks := []EphemeralVmRecipeDoctorCheck{
			{ID: "create-command-present", Status: "pass", Message: "create command is configured"},
		}
		if r.DestroyDisabled || r.Destroy == "" {
			checks = append(checks, EphemeralVmRecipeDoctorCheck{
				ID: "destroy-command-present", Status: "warn",
				Message: "no destroy command configured — cleanup will require manual teardown",
			})
		}
		return EphemeralVmRecipeDoctorResult{RecipeID: recipeID, RepoPath: repoPath, OK: true, Checks: checks}
	}
	return EphemeralVmRecipeDoctorResult{
		RecipeID: recipeID, RepoPath: repoPath, OK: false,
		Checks: []EphemeralVmRecipeDoctorCheck{{ID: "recipe-found", Status: "fail", Message: "recipe " + recipeID + " not found in orca.yaml"}},
	}
}

// GetEphemeralVmCleanupCommand mirrors desktop's getEphemeralVmCleanupCommand
// (desktop/src/main/ipc/ephemeral-vm-runtime-handlers.ts:231-268): a pure
// preview of the destroy command a cleanup would run, with no execution.
// runtimeID/recipeID/repoPath/workspaceID are already resolved by the
// caller (ListEphemeralVmRuntimes' result — see TASK-002) since this
// service has no runtime-record storage of its own (that lives in
// infra-fleet-service, TASK-002's new table).
func GetEphemeralVmCleanupCommand(recipe domain.EphemeralVmRecipe) (command string, cleanupDisabled bool) {
	if recipe.DestroyDisabled || recipe.Destroy == "" {
		return "", true
	}
	return recipe.Destroy, false
}
```

**Known gap, called out rather than silently narrowed:** desktop's real `doctorEphemeralVmRecipe` (`desktop/src/main/speech/../ephemeral-vm-recipe-doctor.ts` per SOL-004's citation) does real `command -v`-style PATH/executable checks against the **local** filesystem, because desktop IS the execution host. A `backend-go` pod is never the execution host for a recipe (`EphemeralVmRelay`'s own doc comment, TASK-004) — command-path checks would need to run on the repo's Dev Server instead, which requires an agent-side check-path RPC that does not exist today. This task ships the check that IS answerable without one (does the recipe exist, is `create` configured) and explicitly does not fake the PATH check; a future task can add a real remote check-path call once/if an agent method exists for it.

## Verify

```bash
cd backend-go/services/git-gateway-service
go build ./...
go vet ./...
go test ./internal/usecase/... -run TestReadEphemeralVmRecipes -v
```

(TASK-002/TASK-003 add the gRPC/wscompat layers and their own tests; this task's own test file — `read_ephemeral_vm_recipes_test.go`, fake `ProjectClient`/`GitExecutor`, local vs. relay dispatch mirroring `check_hooks_test.go`'s existing structure, plus a malformed-YAML-produces-Diagnostics-not-error case — should be added alongside this usecase in the same PR.)
