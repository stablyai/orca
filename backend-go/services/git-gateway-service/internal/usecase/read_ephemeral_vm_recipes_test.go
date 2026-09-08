package usecase

import (
	"context"
	"testing"

	"github.com/stablyai/orca-go/services/git-gateway-service/internal/domain"
)

func TestReadEphemeralVmRecipes_MissingRepoID_ReturnsError(t *testing.T) {
	uc := NewReadEphemeralVmRecipes(&fakeDevServerReachability{}, &fakeProjectClient{}, &fakeFilesystemExecutor{}, &fakeFilesystemExecutor{})
	_, err := uc.Execute(context.Background(), ReadEphemeralVmRecipesInput{})
	if err == nil {
		t.Fatal("expected error for missing repo_id")
	}
}

func TestReadEphemeralVmRecipes_RepoNotFound_ReturnsError(t *testing.T) {
	projects := &fakeProjectClient{getRepoErr: context.DeadlineExceeded}
	uc := NewReadEphemeralVmRecipes(&fakeDevServerReachability{}, projects, &fakeFilesystemExecutor{}, &fakeFilesystemExecutor{})
	_, err := uc.Execute(context.Background(), ReadEphemeralVmRecipesInput{RepoID: "repo-1"})
	if err == nil {
		t.Fatal("expected error when GetRepo fails")
	}
}

func TestReadEphemeralVmRecipes_ReachableDevServer_DispatchesToRelay(t *testing.T) {
	projects := &fakeProjectClient{getRepoResult: domain.RepoInfo{ID: "repo-1", DevServerID: "ds1", URL: "/srv/repo"}}
	reachability := &fakeDevServerReachability{reachable: true}
	relay := &fakeFilesystemExecutor{readFileContent: []byte("environmentRecipes:\n  - id: r1\n    create: docker run\n")}
	local := &fakeFilesystemExecutor{}
	uc := NewReadEphemeralVmRecipes(reachability, projects, local, relay)

	got, err := uc.Execute(context.Background(), ReadEphemeralVmRecipesInput{RepoID: "repo-1"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !relay.calledReadFile || local.calledReadFile {
		t.Error("expected relay executor to be called, not local")
	}
	if len(got.Recipes) != 1 || got.Recipes[0].ID != "r1" {
		t.Errorf("unexpected recipes: %+v", got.Recipes)
	}
}

func TestReadEphemeralVmRecipes_NoDevServer_DispatchesToLocal(t *testing.T) {
	projects := &fakeProjectClient{getRepoResult: domain.RepoInfo{ID: "repo-1", URL: "/local/repo"}}
	reachability := &fakeDevServerReachability{}
	local := &fakeFilesystemExecutor{readFileContent: []byte("environmentRecipes: []")}
	relay := &fakeFilesystemExecutor{}
	uc := NewReadEphemeralVmRecipes(reachability, projects, local, relay)

	got, err := uc.Execute(context.Background(), ReadEphemeralVmRecipesInput{RepoID: "repo-1"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !local.calledReadFile || relay.calledReadFile {
		t.Error("expected local executor to be called, not relay")
	}
	if len(got.Recipes) != 0 {
		t.Errorf("expected zero recipes, got %+v", got.Recipes)
	}
}

func TestReadEphemeralVmRecipes_OrcaYamlMissing_ReturnsZeroRecipesNotError(t *testing.T) {
	projects := &fakeProjectClient{getRepoResult: domain.RepoInfo{ID: "repo-1", URL: "/local/repo"}}
	local := &fakeFilesystemExecutor{readFileErr: context.DeadlineExceeded}
	uc := NewReadEphemeralVmRecipes(&fakeDevServerReachability{}, projects, local, &fakeFilesystemExecutor{})

	got, err := uc.Execute(context.Background(), ReadEphemeralVmRecipesInput{RepoID: "repo-1"})
	if err != nil {
		t.Fatalf("expected no error when orca.yaml is absent, got %v", err)
	}
	if len(got.Recipes) != 0 || len(got.Diagnostics) != 0 {
		t.Errorf("expected empty result, got %+v", got)
	}
}

func TestReadEphemeralVmRecipes_MalformedYaml_ProducesDiagnosticNotError(t *testing.T) {
	projects := &fakeProjectClient{getRepoResult: domain.RepoInfo{ID: "repo-1", URL: "/local/repo"}}
	local := &fakeFilesystemExecutor{readFileContent: []byte("not: valid: yaml: [")}
	uc := NewReadEphemeralVmRecipes(&fakeDevServerReachability{}, projects, local, &fakeFilesystemExecutor{})

	got, err := uc.Execute(context.Background(), ReadEphemeralVmRecipesInput{RepoID: "repo-1"})
	if err != nil {
		t.Fatalf("expected no error for malformed yaml, got %v", err)
	}
	if len(got.Diagnostics) == 0 {
		t.Error("expected a diagnostic for malformed yaml")
	}
}

func TestReadEphemeralVmRecipes_RecipeMissingCreate_SkippedWithDiagnostic(t *testing.T) {
	raw := []byte("environmentRecipes:\n  - id: r1\n  - id: r2\n    create: docker run\n")
	got := parseEnvironmentRecipes("/repo", raw)
	if len(got.Recipes) != 1 || got.Recipes[0].ID != "r2" {
		t.Errorf("expected only r2 to survive, got %+v", got.Recipes)
	}
	if len(got.Diagnostics) != 1 {
		t.Errorf("expected 1 diagnostic for r1's missing create, got %+v", got.Diagnostics)
	}
}

func TestDoctorEphemeralVmRecipe_RecipeFound_OK(t *testing.T) {
	recipes := []domain.EphemeralVmRecipe{{ID: "r1", Create: "docker run", Destroy: "docker rm"}}
	got := DoctorEphemeralVmRecipe("/repo", "r1", recipes)
	if !got.OK {
		t.Errorf("expected OK, got %+v", got)
	}
}

func TestDoctorEphemeralVmRecipe_RecipeMissing_Fails(t *testing.T) {
	got := DoctorEphemeralVmRecipe("/repo", "missing", nil)
	if got.OK {
		t.Errorf("expected not OK, got %+v", got)
	}
}

func TestDoctorEphemeralVmRecipe_NoDestroy_Warns(t *testing.T) {
	recipes := []domain.EphemeralVmRecipe{{ID: "r1", Create: "docker run"}}
	got := DoctorEphemeralVmRecipe("/repo", "r1", recipes)
	if !got.OK {
		t.Fatalf("expected OK, got %+v", got)
	}
	found := false
	for _, c := range got.Checks {
		if c.ID == "destroy-command-present" && c.Status == "warn" {
			found = true
		}
	}
	if !found {
		t.Errorf("expected a warn check for missing destroy command, got %+v", got.Checks)
	}
}

func TestGetEphemeralVmCleanupCommand_DestroyDisabled_ReturnsDisabled(t *testing.T) {
	cmd, disabled := GetEphemeralVmCleanupCommand(domain.EphemeralVmRecipe{Destroy: "rm -rf", DestroyDisabled: true})
	if cmd != "" || !disabled {
		t.Errorf("expected empty command and disabled=true, got %q %v", cmd, disabled)
	}
}

func TestGetEphemeralVmCleanupCommand_HasDestroy_ReturnsCommand(t *testing.T) {
	cmd, disabled := GetEphemeralVmCleanupCommand(domain.EphemeralVmRecipe{Destroy: "docker rm -f x"})
	if cmd != "docker rm -f x" || disabled {
		t.Errorf("expected command to pass through, got %q %v", cmd, disabled)
	}
}
