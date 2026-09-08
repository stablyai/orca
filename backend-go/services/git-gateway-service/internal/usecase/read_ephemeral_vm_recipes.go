package usecase

import (
	"context"
	"strconv"

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
// Mirrors CheckHooks's GetRepo -> dispatch -> single named read shape, but
// dispatches a FilesystemExecutor, not a GitExecutor: unlike SOL-004's
// original sketch, ReadFile is declared on FilesystemExecutor (ports.go),
// not GitExecutor — localgit.Executor (this service's GitExecutor "local")
// has no ReadFile method, only localfs.Executor/RelayExecutor do. A
// malformed orca.yaml produces Diagnostics, not an error — matching
// desktop's loadHooks' own tolerant parsing (a broken environmentRecipes
// block must not block reading repo/worktree state elsewhere).
type ReadEphemeralVmRecipes struct {
	reachability DevServerReachability
	projects     ProjectClient
	local        FilesystemExecutor
	relay        FilesystemExecutor
}

func NewReadEphemeralVmRecipes(reachability DevServerReachability, projects ProjectClient, local, relay FilesystemExecutor) *ReadEphemeralVmRecipes {
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
	ctx, executor, repoPath, err := dispatchFilesystemExecutorForRepo(ctx, uc.reachability, uc.local, uc.relay, repo)
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
			diagnostics = append(diagnostics, "environmentRecipes["+strconv.Itoa(i)+"]: id and create are required, skipping")
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

// EphemeralVmRecipeDoctorCheck mirrors EphemeralVmRecipeDoctorCheckStatus
// ("pass" | "warn" | "fail") from frontend/src/shared/types.ts.
type EphemeralVmRecipeDoctorCheck struct {
	ID          string
	Status      string
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
