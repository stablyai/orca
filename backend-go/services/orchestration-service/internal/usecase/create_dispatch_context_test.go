package usecase

import (
	"context"
	"errors"
	"testing"

	"github.com/stablyai/orca-go/common/tenant"
)

func withTenant(ctx context.Context, tenantID string) context.Context {
	return tenant.WithTenantID(ctx, tenantID)
}

func TestCreateDispatchContext_RequiresTenantContext(t *testing.T) {
	uc := NewCreateDispatchContext(&fakeDispatchContextRepository{}, &synchronousSerializer{})
	_, err := uc.Execute(context.Background(), CreateDispatchContextInput{Handle: "handle-1"})
	if err == nil {
		t.Fatal("expected an error when no tenant is in context")
	}
}

func TestCreateDispatchContext_RequiresHandle(t *testing.T) {
	uc := NewCreateDispatchContext(&fakeDispatchContextRepository{}, &synchronousSerializer{})
	ctx := withTenant(context.Background(), "tenant-1")
	_, err := uc.Execute(ctx, CreateDispatchContextInput{})
	if err == nil {
		t.Fatal("expected an error for empty handle")
	}
}

func TestCreateDispatchContext_CreatesAndKeysSerializerByHandle(t *testing.T) {
	repo := &fakeDispatchContextRepository{}
	ser := &synchronousSerializer{}
	uc := NewCreateDispatchContext(repo, ser)

	ctx := withTenant(context.Background(), "tenant-1")
	got, err := uc.Execute(ctx, CreateDispatchContextInput{Handle: "handle-1", CoordinatorRunID: "run-1"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Handle != "handle-1" || got.TenantID != "tenant-1" {
		t.Errorf("unexpected result: %+v", got)
	}
	if len(repo.created) != 1 {
		t.Fatalf("expected 1 created dispatch context, got %d", len(repo.created))
	}
	if keys := ser.calledKeys(); len(keys) != 1 || keys[0] != "handle-1" {
		t.Errorf("expected serializer keyed by handle-1, got %v", keys)
	}
}

// TestCreateDispatchContext_ThreadsOrchestrationTaskID proves the Epic C
// wiring (docs/execution-plan.md): a caller-supplied OrchestrationTaskID
// reaches the repository call, not just Handle/CoordinatorRunID.
func TestCreateDispatchContext_ThreadsOrchestrationTaskID(t *testing.T) {
	repo := &fakeDispatchContextRepository{}
	uc := NewCreateDispatchContext(repo, &synchronousSerializer{})

	ctx := withTenant(context.Background(), "tenant-1")
	got, err := uc.Execute(ctx, CreateDispatchContextInput{
		Handle:              "handle-1",
		CoordinatorRunID:    "run-1",
		OrchestrationTaskID: "task-1",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.OrchestrationTaskID != "task-1" {
		t.Errorf("expected result OrchestrationTaskID %q, got %q", "task-1", got.OrchestrationTaskID)
	}
	if len(repo.created) != 1 || repo.created[0].OrchestrationTaskID != "task-1" {
		t.Fatalf("expected repository to receive OrchestrationTaskID, got %+v", repo.created)
	}
}

// TestCreateDispatchContext_ThreadsWorktreeID proves a caller-supplied
// WorktreeID reaches the repository call and round-trips on the result —
// see docs/backlog/BACKLOG-013-dispatch-context-handle-worktree-linkage.md.
func TestCreateDispatchContext_ThreadsWorktreeID(t *testing.T) {
	repo := &fakeDispatchContextRepository{}
	uc := NewCreateDispatchContext(repo, &synchronousSerializer{})

	ctx := withTenant(context.Background(), "tenant-1")
	got, err := uc.Execute(ctx, CreateDispatchContextInput{
		Handle:           "handle-1",
		CoordinatorRunID: "run-1",
		WorktreeID:       "repo-1::/opt/worktree",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.WorktreeID != "repo-1::/opt/worktree" {
		t.Errorf("expected result WorktreeID %q, got %q", "repo-1::/opt/worktree", got.WorktreeID)
	}
	if len(repo.created) != 1 || repo.created[0].WorktreeID != "repo-1::/opt/worktree" {
		t.Fatalf("expected repository to receive WorktreeID, got %+v", repo.created)
	}
}

func TestCreateDispatchContext_RepositoryFailurePropagates(t *testing.T) {
	repo := &fakeDispatchContextRepository{err: errors.New("db unavailable")}
	uc := NewCreateDispatchContext(repo, &synchronousSerializer{})

	ctx := withTenant(context.Background(), "tenant-1")
	_, err := uc.Execute(ctx, CreateDispatchContextInput{Handle: "handle-1"})
	if err == nil {
		t.Fatal("expected error to propagate from repository failure")
	}
}
