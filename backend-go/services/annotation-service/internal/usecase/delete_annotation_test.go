package usecase

import (
	"context"
	"errors"
	"testing"

	"google.golang.org/grpc"
	"google.golang.org/protobuf/types/known/emptypb"

	"github.com/stablyai/orca-go/common/auditclient"
	"github.com/stablyai/orca-go/common/tenant"

	authv1 "github.com/stablyai/orca-go/proto/gen/go/orca/auth/v1"
)

// fakeAuthServiceClient stubs AppendAuditEntry only — every other
// AuthServiceClient method is left nil-embedded and unused, mirroring
// common/auditclient/client_test.go's own fake.
type fakeAuthServiceClient struct {
	authv1.AuthServiceClient
	calls   int
	lastReq *authv1.AppendAuditEntryRequest
}

func (f *fakeAuthServiceClient) AppendAuditEntry(_ context.Context, in *authv1.AppendAuditEntryRequest, _ ...grpc.CallOption) (*emptypb.Empty, error) {
	f.calls++
	f.lastReq = in
	return &emptypb.Empty{}, nil
}

func TestDeleteAnnotation_RequiresTenantContext(t *testing.T) {
	uc := NewDeleteAnnotation(newFakeRepository(), newFakeOPAClient(true), nil)
	err := uc.Execute(context.Background(), DeleteAnnotationInput{ID: "a1"})
	if err == nil {
		t.Fatal("expected an error when no tenant is in context")
	}
}

func TestDeleteAnnotation_RequiresUserContext(t *testing.T) {
	uc := NewDeleteAnnotation(newFakeRepository(), newFakeOPAClient(true), nil)
	ctx := tenant.WithTenantID(context.Background(), "tenant-1")
	err := uc.Execute(ctx, DeleteAnnotationInput{ID: "a1"})
	if err == nil {
		t.Fatal("expected an error when no user is in context")
	}
}

func TestDeleteAnnotation_RequiresID(t *testing.T) {
	uc := NewDeleteAnnotation(newFakeRepository(), newFakeOPAClient(true), nil)
	ctx := withIdentity(context.Background(), "tenant-1", "user-1")
	err := uc.Execute(ctx, DeleteAnnotationInput{})
	if err == nil {
		t.Fatal("expected an error when id is empty")
	}
}

func TestDeleteAnnotation_NotFoundPropagates(t *testing.T) {
	uc := NewDeleteAnnotation(newFakeRepository(), newFakeOPAClient(true), nil)
	ctx := withIdentity(context.Background(), "tenant-1", "user-1")
	err := uc.Execute(ctx, DeleteAnnotationInput{ID: "missing"})
	if err == nil {
		t.Fatal("expected an error for an annotation that doesn't exist")
	}
}

func TestDeleteAnnotation_DeletesExisting(t *testing.T) {
	repo := newFakeRepository()
	ctx := withIdentity(context.Background(), "tenant-1", "user-1")

	created, err := NewCreateAnnotation(repo).Execute(ctx, CreateAnnotationInput{
		RepoID: "repo-1", FilePath: "main.go", Line: 1, Content: "original", RequestID: "req-seed",
	})
	if err != nil {
		t.Fatalf("seed create: %v", err)
	}

	if err := NewDeleteAnnotation(repo, newFakeOPAClient(true), nil).Execute(ctx, DeleteAnnotationInput{ID: created.ID}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if _, ok := repo.byID[created.ID]; ok {
		t.Error("expected annotation to be removed from repository")
	}
}

// TestDeleteAnnotation_AuthorMayDelete exercises the author-matches-actor
// allow branch (via the fake OPA client) — the annotation's author
// deleting their own annotation.
func TestDeleteAnnotation_AuthorMayDelete(t *testing.T) {
	repo := newFakeRepository()
	createCtx := withIdentity(context.Background(), "tenant-1", "author-1")
	created, err := NewCreateAnnotation(repo).Execute(createCtx, CreateAnnotationInput{
		RepoID: "repo-1", FilePath: "main.go", Line: 1, Content: "original", RequestID: "req-seed",
	})
	if err != nil {
		t.Fatalf("seed create: %v", err)
	}

	opa := newFakeOPAClient(true)
	ctx := withIdentity(context.Background(), "tenant-1", "author-1")
	if err := NewDeleteAnnotation(repo, opa, nil).Execute(ctx, DeleteAnnotationInput{ID: created.ID}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if _, ok := repo.byID[created.ID]; ok {
		t.Error("expected annotation to be removed from repository")
	}
	if len(opa.calls) != 1 || opa.calls[0].actorID != "author-1" || opa.calls[0].authorID != "author-1" {
		t.Errorf("expected OPA to be queried with actor==author, got %+v", opa.calls)
	}
}

// TestDeleteAnnotation_NonAuthorNonAdminDenied covers the deny path and
// asserts the mutation never reaches the repository — the annotation must
// still exist afterward.
func TestDeleteAnnotation_NonAuthorNonAdminDenied(t *testing.T) {
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
	err = NewDeleteAnnotation(repo, opa, nil).Execute(ctx, DeleteAnnotationInput{ID: created.ID})
	if err == nil {
		t.Fatal("expected a permission-denied error for a non-author, non-admin caller")
	}
	if len(opa.calls) != 1 || opa.calls[0].actorID != "someone-else" || opa.calls[0].authorID != "author-1" {
		t.Errorf("expected OPA to be queried with actor!=author, got %+v", opa.calls)
	}
	if _, ok := repo.byID[created.ID]; !ok {
		t.Error("expected the annotation to still exist — denied delete must not mutate")
	}
}

// TestDeleteAnnotation_OPAErrorFailsClosed asserts that an evaluator error
// denies the request rather than allowing it — fail closed, per
// common/policy.Evaluator's contract.
func TestDeleteAnnotation_OPAErrorFailsClosed(t *testing.T) {
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
	err = NewDeleteAnnotation(repo, opa, nil).Execute(ctx, DeleteAnnotationInput{ID: created.ID})
	if err == nil {
		t.Fatal("expected an error when the policy evaluator fails")
	}
	if _, ok := repo.byID[created.ID]; !ok {
		t.Error("expected the annotation to still exist — evaluator error must fail closed")
	}
}

// --- TASK-BE-021: audit-append on both allow and deny branches ---

func TestDeleteAnnotation_DeniedCallAppendsExactlyOneDeniedAuditEntry(t *testing.T) {
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
	err = NewDeleteAnnotation(repo, opa, auditclient.New(fake)).Execute(ctx, DeleteAnnotationInput{ID: created.ID})
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
	if fake.lastReq.GetActorId() != "someone-else" {
		t.Fatalf("expected actor_id %q, got %q", "someone-else", fake.lastReq.GetActorId())
	}
}

func TestDeleteAnnotation_AllowedCallAppendsExactlyOneAllowedAuditEntry(t *testing.T) {
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
	if err := NewDeleteAnnotation(repo, newFakeOPAClient(true), auditclient.New(fake)).Execute(ctx, DeleteAnnotationInput{ID: created.ID}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if fake.calls != 1 {
		t.Fatalf("expected exactly one AppendAuditEntry call, got %d", fake.calls)
	}
	if fake.lastReq.GetOutcome() != "allowed" {
		t.Fatalf("expected outcome %q, got %q", "allowed", fake.lastReq.GetOutcome())
	}
}

// TestDeleteAnnotation_AuditAppendFailureDoesNotAffectDecision proves the
// permission decision is authoritative — a real Append never returns an
// error to this usecase regardless of the underlying RPC's outcome (see
// auditclient.Client.Append's doc comment); this only confirms
// requireProjectAccess-style callers don't need to special-case it either.
func TestDeleteAnnotation_AuditAppendFailureDoesNotAffectDecision(t *testing.T) {
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
	if err := NewDeleteAnnotation(repo, newFakeOPAClient(true), auditclient.New(fake)).Execute(ctx, DeleteAnnotationInput{ID: created.ID}); err != nil {
		t.Fatalf("expected allow despite the audit-append, got: %v", err)
	}
}
