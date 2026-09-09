package usecase

import (
	"context"
	"errors"
	"testing"

	"github.com/stablyai/orca-go/common/auditclient"
	"github.com/stablyai/orca-go/common/tenant"
)

func TestUpdateAnnotation_RequiresTenantContext(t *testing.T) {
	uc := NewUpdateAnnotation(newFakeRepository(), newFakeOPAClient(true), nil)
	_, err := uc.Execute(context.Background(), UpdateAnnotationInput{ID: "a1", Content: "edited"})
	if err == nil {
		t.Fatal("expected an error when no tenant is in context")
	}
}

func TestUpdateAnnotation_RequiresUserContext(t *testing.T) {
	uc := NewUpdateAnnotation(newFakeRepository(), newFakeOPAClient(true), nil)
	ctx := tenant.WithTenantID(context.Background(), "tenant-1")
	_, err := uc.Execute(ctx, UpdateAnnotationInput{ID: "a1", Content: "edited"})
	if err == nil {
		t.Fatal("expected an error when no user is in context")
	}
}

func TestUpdateAnnotation_RequiresID(t *testing.T) {
	uc := NewUpdateAnnotation(newFakeRepository(), newFakeOPAClient(true), nil)
	ctx := withIdentity(context.Background(), "tenant-1", "user-1")
	_, err := uc.Execute(ctx, UpdateAnnotationInput{Content: "edited"})
	if err == nil {
		t.Fatal("expected an error when id is empty")
	}
}

func TestUpdateAnnotation_RequiresContent(t *testing.T) {
	uc := NewUpdateAnnotation(newFakeRepository(), newFakeOPAClient(true), nil)
	ctx := withIdentity(context.Background(), "tenant-1", "user-1")
	_, err := uc.Execute(ctx, UpdateAnnotationInput{ID: "a1"})
	if err == nil {
		t.Fatal("expected an error when content is empty")
	}
}

func TestUpdateAnnotation_NotFoundPropagates(t *testing.T) {
	uc := NewUpdateAnnotation(newFakeRepository(), newFakeOPAClient(true), nil)
	ctx := withIdentity(context.Background(), "tenant-1", "user-1")
	_, err := uc.Execute(ctx, UpdateAnnotationInput{ID: "missing", Content: "edited"})
	if err == nil {
		t.Fatal("expected an error for an annotation that doesn't exist")
	}
}

func TestUpdateAnnotation_UpdatesContentAndResolved(t *testing.T) {
	repo := newFakeRepository()
	ctx := withIdentity(context.Background(), "tenant-1", "user-1")

	created, err := NewCreateAnnotation(repo).Execute(ctx, CreateAnnotationInput{
		RepoID: "repo-1", FilePath: "main.go", Line: 1, Content: "original", RequestID: "req-seed",
	})
	if err != nil {
		t.Fatalf("seed create: %v", err)
	}

	updated, err := NewUpdateAnnotation(repo, newFakeOPAClient(true), nil).Execute(ctx, UpdateAnnotationInput{
		ID: created.ID, Content: "edited", Resolved: true,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if updated.Content != "edited" || !updated.Resolved {
		t.Errorf("expected updated content/resolved, got %+v", updated)
	}
}

// TestUpdateAnnotation_AuthorMayEdit exercises the author-matches-actor
// allow branch of data.orca.authz.annotation.allow (via the fake OPA
// client standing in for it) — the annotation's author (user-1) editing
// their own annotation.
func TestUpdateAnnotation_AuthorMayEdit(t *testing.T) {
	repo := newFakeRepository()
	createCtx := withIdentity(context.Background(), "tenant-1", "author-1")
	created, err := NewCreateAnnotation(repo).Execute(createCtx, CreateAnnotationInput{
		RepoID: "repo-1", FilePath: "main.go", Line: 1, Content: "original", RequestID: "req-seed",
	})
	if err != nil {
		t.Fatalf("seed create: %v", err)
	}

	opa := newFakeOPAClient(true) // stands in for actor_id == author_id
	ctx := withIdentity(context.Background(), "tenant-1", "author-1")
	updated, err := NewUpdateAnnotation(repo, opa, nil).Execute(ctx, UpdateAnnotationInput{
		ID: created.ID, Content: "edited by author",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if updated.Content != "edited by author" {
		t.Errorf("expected content to be updated, got %+v", updated)
	}
	if len(opa.calls) != 1 || opa.calls[0].actorID != "author-1" || opa.calls[0].authorID != "author-1" {
		t.Errorf("expected OPA to be queried with actor==author, got %+v", opa.calls)
	}
}

// TestUpdateAnnotation_NonAuthorNonAdminDenied covers the deny path: a
// caller who is neither the annotation's author nor (per the known
// actor-role-propagation gap — see README "Known gaps") ever resolved as
// admin. It also asserts the mutation never reaches the repository.
func TestUpdateAnnotation_NonAuthorNonAdminDenied(t *testing.T) {
	repo := newFakeRepository()
	createCtx := withIdentity(context.Background(), "tenant-1", "author-1")
	created, err := NewCreateAnnotation(repo).Execute(createCtx, CreateAnnotationInput{
		RepoID: "repo-1", FilePath: "main.go", Line: 1, Content: "original", RequestID: "req-seed",
	})
	if err != nil {
		t.Fatalf("seed create: %v", err)
	}

	opa := newFakeOPAClient(false)
	ctx := withIdentity(context.Background(), "tenant-1", "someone-else")
	_, err = NewUpdateAnnotation(repo, opa, nil).Execute(ctx, UpdateAnnotationInput{
		ID: created.ID, Content: "hijacked",
	})
	if err == nil {
		t.Fatal("expected a permission-denied error for a non-author, non-admin caller")
	}
	if len(opa.calls) != 1 || opa.calls[0].actorID != "someone-else" || opa.calls[0].authorID != "author-1" {
		t.Errorf("expected OPA to be queried with actor!=author, got %+v", opa.calls)
	}
	if got := repo.byID[created.ID]; got.Content != "original" {
		t.Errorf("expected the mutation to be rejected before touching the repository, got content %q", got.Content)
	}
}

// TestUpdateAnnotation_OPAErrorFailsClosed asserts that an evaluator error
// denies the request rather than allowing it — fail closed, per
// common/policy.Evaluator's contract.
func TestUpdateAnnotation_OPAErrorFailsClosed(t *testing.T) {
	repo := newFakeRepository()
	createCtx := withIdentity(context.Background(), "tenant-1", "author-1")
	created, err := NewCreateAnnotation(repo).Execute(createCtx, CreateAnnotationInput{
		RepoID: "repo-1", FilePath: "main.go", Line: 1, Content: "original", RequestID: "req-seed",
	})
	if err != nil {
		t.Fatalf("seed create: %v", err)
	}

	opa := newFakeOPAClient(true)
	opa.err = errors.New("bundle unavailable")
	ctx := withIdentity(context.Background(), "tenant-1", "author-1")
	_, err = NewUpdateAnnotation(repo, opa, nil).Execute(ctx, UpdateAnnotationInput{
		ID: created.ID, Content: "should not apply",
	})
	if err == nil {
		t.Fatal("expected an error when the policy evaluator fails")
	}
	if got := repo.byID[created.ID]; got.Content != "original" {
		t.Errorf("expected the mutation to be rejected on evaluator error, got content %q", got.Content)
	}
}

// --- TASK-BE-021: audit-append on both allow and deny branches ---

func TestUpdateAnnotation_DeniedCallAppendsExactlyOneDeniedAuditEntry(t *testing.T) {
	repo := newFakeRepository()
	createCtx := withIdentity(context.Background(), "tenant-1", "author-1")
	created, err := NewCreateAnnotation(repo).Execute(createCtx, CreateAnnotationInput{
		RepoID: "repo-1", FilePath: "main.go", Line: 1, Content: "original", RequestID: "req-seed",
	})
	if err != nil {
		t.Fatalf("seed create: %v", err)
	}

	fake := &fakeAuthServiceClient{}
	opa := newFakeOPAClient(false)
	ctx := withIdentity(context.Background(), "tenant-1", "someone-else")
	_, err = NewUpdateAnnotation(repo, opa, auditclient.New(fake)).Execute(ctx, UpdateAnnotationInput{
		ID: created.ID, Content: "hijacked",
	})
	if err == nil {
		t.Fatal("expected a permission-denied error")
	}
	if fake.calls != 1 {
		t.Fatalf("expected exactly one AppendAuditEntry call, got %d", fake.calls)
	}
	if fake.lastReq.GetOutcome() != "denied" {
		t.Fatalf("expected outcome %q, got %q", "denied", fake.lastReq.GetOutcome())
	}
	if fake.lastReq.GetTarget() != "annotation:"+created.ID {
		t.Fatalf("expected target %q, got %q", "annotation:"+created.ID, fake.lastReq.GetTarget())
	}
}

func TestUpdateAnnotation_AllowedCallAppendsExactlyOneAllowedAuditEntry(t *testing.T) {
	repo := newFakeRepository()
	createCtx := withIdentity(context.Background(), "tenant-1", "author-1")
	created, err := NewCreateAnnotation(repo).Execute(createCtx, CreateAnnotationInput{
		RepoID: "repo-1", FilePath: "main.go", Line: 1, Content: "original", RequestID: "req-seed",
	})
	if err != nil {
		t.Fatalf("seed create: %v", err)
	}

	fake := &fakeAuthServiceClient{}
	ctx := withIdentity(context.Background(), "tenant-1", "author-1")
	if _, err := NewUpdateAnnotation(repo, newFakeOPAClient(true), auditclient.New(fake)).Execute(ctx, UpdateAnnotationInput{
		ID: created.ID, Content: "edited by author",
	}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if fake.calls != 1 {
		t.Fatalf("expected exactly one AppendAuditEntry call, got %d", fake.calls)
	}
	if fake.lastReq.GetOutcome() != "allowed" {
		t.Fatalf("expected outcome %q, got %q", "allowed", fake.lastReq.GetOutcome())
	}
}
