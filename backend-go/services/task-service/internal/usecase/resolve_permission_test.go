package usecase

import (
	"context"
	"errors"
	"testing"

	"google.golang.org/grpc"
	"google.golang.org/protobuf/types/known/emptypb"

	"github.com/stablyai/orca-go/common/auditclient"
	"github.com/stablyai/orca-go/services/task-service/internal/domain"

	authv1 "github.com/stablyai/orca-go/proto/gen/go/orca/auth/v1"
)

func setupChain(t *testing.T, repo *fakeTaskRepository, tenantID string, ids ...string) {
	t.Helper()
	parent := ""
	for _, id := range ids {
		task, err := domain.NewTask(id, tenantID, id, domain.StatusOpen, parent, "")
		if err != nil {
			t.Fatalf("building task %s: %v", id, err)
		}
		repo.tasks[id] = task
		parent = id
	}
}

func TestResolvePermission_RequiresTenantContext(t *testing.T) {
	uc := NewResolvePermission(newFakeTaskRepository(), &fakeGrantRepository{}, &fakeTeamScopeResolver{}, &fakeOPAClient{allow: true}, nil)
	_, err := uc.Execute(context.Background(), ResolvePermissionInput{TaskID: "t1", UserID: "u1"})
	if err == nil {
		t.Fatal("expected an error when no tenant is in context")
	}
}

func TestResolvePermission_ResolvesAGrantOnTheTaskItself(t *testing.T) {
	tasks := newFakeTaskRepository()
	setupChain(t, tasks, "tenant-1", "root", "child")
	grants := &fakeGrantRepository{grants: []domain.Grant{
		{TaskID: "child", SubjectID: "user-1", Level: domain.GrantLevelOwner, ApplyTree: false},
	}}
	opa := &fakeOPAClient{allow: true}
	uc := NewResolvePermission(tasks, grants, &fakeTeamScopeResolver{}, opa, nil)
	ctx := withIdentity(context.Background(), "tenant-1", "user-1")

	level, err := uc.Execute(ctx, ResolvePermissionInput{TaskID: "child", UserID: "user-1", Action: "admin"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if level != domain.GrantLevelOwner {
		t.Errorf("expected GrantLevelOwner, got %v", level)
	}
	if !opa.called {
		t.Error("expected OPAClient.Decision to be called once a grant was resolved")
	}
}

func TestResolvePermission_ResolvesAnInheritedAncestorGrant(t *testing.T) {
	tasks := newFakeTaskRepository()
	setupChain(t, tasks, "tenant-1", "root", "parent", "child")
	grants := &fakeGrantRepository{grants: []domain.Grant{
		{TaskID: "root", SubjectID: "user-1", Level: domain.GrantLevelAdmin, ApplyTree: true},
	}}
	uc := NewResolvePermission(tasks, grants, &fakeTeamScopeResolver{}, &fakeOPAClient{allow: true}, nil)
	ctx := withIdentity(context.Background(), "tenant-1", "user-1")

	level, err := uc.Execute(ctx, ResolvePermissionInput{TaskID: "child", UserID: "user-1", Action: "read"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if level != domain.GrantLevelAdmin {
		t.Errorf("expected GrantLevelAdmin from the inherited root grant, got %v", level)
	}
}

func TestResolvePermission_UsesTeamScopeResolverForTeamGrants(t *testing.T) {
	tasks := newFakeTaskRepository()
	setupChain(t, tasks, "tenant-1", "task-1")
	grants := &fakeGrantRepository{grants: []domain.Grant{
		{TaskID: "task-1", SubjectID: "team-a", Level: domain.GrantLevelTeam, ApplyTree: false},
	}}
	teams := &fakeTeamScopeResolver{teams: []string{"team-a"}}
	uc := NewResolvePermission(tasks, grants, teams, &fakeOPAClient{allow: true}, nil)
	ctx := withIdentity(context.Background(), "tenant-1", "user-1")

	level, err := uc.Execute(ctx, ResolvePermissionInput{TaskID: "task-1", UserID: "user-1", Action: "read"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if level != domain.GrantLevelTeam {
		t.Errorf("expected GrantLevelTeam, got %v", level)
	}
}

func TestResolvePermission_DeniesWhenNoGrantMatches(t *testing.T) {
	tasks := newFakeTaskRepository()
	setupChain(t, tasks, "tenant-1", "task-1")
	opa := &fakeOPAClient{allow: true}
	uc := NewResolvePermission(tasks, &fakeGrantRepository{}, &fakeTeamScopeResolver{}, opa, nil)
	ctx := withIdentity(context.Background(), "tenant-1", "user-1")

	if _, err := uc.Execute(ctx, ResolvePermissionInput{TaskID: "task-1", UserID: "user-1", Action: "read"}); err == nil {
		t.Fatal("expected a permission-denied error when no grant matches")
	}
	if opa.called {
		t.Error("OPAClient.Decision must not be called when the BFS walk finds no grant at all")
	}
}

func TestResolvePermission_AllowsWhenOPADecisionIsTrue(t *testing.T) {
	tasks := newFakeTaskRepository()
	setupChain(t, tasks, "tenant-1", "task-1")
	grants := &fakeGrantRepository{grants: []domain.Grant{
		{TaskID: "task-1", SubjectID: "user-1", Level: domain.GrantLevelUser, ApplyTree: false},
	}}
	opa := &fakeOPAClient{allow: true}
	uc := NewResolvePermission(tasks, grants, &fakeTeamScopeResolver{}, opa, nil)
	ctx := withIdentity(context.Background(), "tenant-1", "user-1")

	level, err := uc.Execute(ctx, ResolvePermissionInput{TaskID: "task-1", UserID: "user-1", Action: "write"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if level != domain.GrantLevelUser {
		t.Errorf("expected GrantLevelUser, got %v", level)
	}
}

func TestResolvePermission_DeniesWhenOPADecisionIsFalse(t *testing.T) {
	tasks := newFakeTaskRepository()
	setupChain(t, tasks, "tenant-1", "task-1")
	grants := &fakeGrantRepository{grants: []domain.Grant{
		// Company-level grants match by tenant/company ID (Grant.Matches),
		// so SubjectID must equal the caller's CompanyID (tenantID) here.
		{TaskID: "task-1", SubjectID: "tenant-1", Level: domain.GrantLevelCompany, ApplyTree: false},
	}}
	opa := &fakeOPAClient{allow: false}
	uc := NewResolvePermission(tasks, grants, &fakeTeamScopeResolver{}, opa, nil)
	ctx := withIdentity(context.Background(), "tenant-1", "user-1")

	_, err := uc.Execute(ctx, ResolvePermissionInput{TaskID: "task-1", UserID: "user-1", Action: "write"})
	if err == nil {
		t.Fatal("expected a permission-denied error when OPA denies the requested action")
	}
	if !opa.called {
		t.Error("expected OPAClient.Decision to be called once a grant was resolved")
	}
}

func TestResolvePermission_FailsClosedOnOPAEvaluationError(t *testing.T) {
	tasks := newFakeTaskRepository()
	setupChain(t, tasks, "tenant-1", "task-1")
	grants := &fakeGrantRepository{grants: []domain.Grant{
		{TaskID: "task-1", SubjectID: "user-1", Level: domain.GrantLevelOwner, ApplyTree: false},
	}}
	opa := &fakeOPAClient{decisionErr: errors.New("bundle unavailable")}
	uc := NewResolvePermission(tasks, grants, &fakeTeamScopeResolver{}, opa, nil)
	ctx := withIdentity(context.Background(), "tenant-1", "user-1")

	if _, err := uc.Execute(ctx, ResolvePermissionInput{TaskID: "task-1", UserID: "user-1", Action: "admin"}); err == nil {
		t.Fatal("expected a permission-denied error when OPA evaluation itself fails")
	}
}

// --- TASK-BE-020: audit-append on both allow and deny branches ---

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

func TestResolvePermission_DeniedDecisionAppendsExactlyOneDeniedAuditEntry(t *testing.T) {
	tasks := newFakeTaskRepository()
	setupChain(t, tasks, "tenant-1", "task-1")
	grants := &fakeGrantRepository{grants: []domain.Grant{
		{TaskID: "task-1", SubjectID: "tenant-1", Level: domain.GrantLevelCompany, ApplyTree: false},
	}}
	fake := &fakeAuthServiceClient{}
	uc := NewResolvePermission(tasks, grants, &fakeTeamScopeResolver{}, &fakeOPAClient{allow: false}, auditclient.New(fake))
	ctx := withIdentity(context.Background(), "tenant-1", "user-1")

	if _, err := uc.Execute(ctx, ResolvePermissionInput{TaskID: "task-1", UserID: "user-1", Action: "write"}); err == nil {
		t.Fatal("expected a permission-denied error when OPA denies the requested action")
	}
	if fake.calls != 1 {
		t.Fatalf("expected exactly one AppendAuditEntry call, got %d", fake.calls)
	}
	if fake.lastReq.GetOutcome() != "denied" {
		t.Fatalf("expected outcome %q, got %q", "denied", fake.lastReq.GetOutcome())
	}
	if fake.lastReq.GetTarget() != "task:task-1" {
		t.Fatalf("expected target %q, got %q", "task:task-1", fake.lastReq.GetTarget())
	}
	if fake.lastReq.GetActorId() != "user-1" {
		t.Fatalf("expected actor_id %q, got %q", "user-1", fake.lastReq.GetActorId())
	}
}

func TestResolvePermission_AllowedDecisionAppendsExactlyOneAllowedAuditEntry(t *testing.T) {
	tasks := newFakeTaskRepository()
	setupChain(t, tasks, "tenant-1", "task-1")
	grants := &fakeGrantRepository{grants: []domain.Grant{
		{TaskID: "task-1", SubjectID: "user-1", Level: domain.GrantLevelUser, ApplyTree: false},
	}}
	fake := &fakeAuthServiceClient{}
	uc := NewResolvePermission(tasks, grants, &fakeTeamScopeResolver{}, &fakeOPAClient{allow: true}, auditclient.New(fake))
	ctx := withIdentity(context.Background(), "tenant-1", "user-1")

	if _, err := uc.Execute(ctx, ResolvePermissionInput{TaskID: "task-1", UserID: "user-1", Action: "write"}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if fake.calls != 1 {
		t.Fatalf("expected exactly one AppendAuditEntry call, got %d", fake.calls)
	}
	if fake.lastReq.GetOutcome() != "allowed" {
		t.Fatalf("expected outcome %q, got %q", "allowed", fake.lastReq.GetOutcome())
	}
}

// TestResolvePermission_NilAuditClientIsANoOp proves the auditClient is
// optional (most existing tests above never wire one) and never panics.
func TestResolvePermission_NilAuditClientIsANoOp(t *testing.T) {
	tasks := newFakeTaskRepository()
	setupChain(t, tasks, "tenant-1", "task-1")
	grants := &fakeGrantRepository{grants: []domain.Grant{
		{TaskID: "task-1", SubjectID: "user-1", Level: domain.GrantLevelUser, ApplyTree: false},
	}}
	uc := NewResolvePermission(tasks, grants, &fakeTeamScopeResolver{}, &fakeOPAClient{allow: true}, nil)
	ctx := withIdentity(context.Background(), "tenant-1", "user-1")

	if _, err := uc.Execute(ctx, ResolvePermissionInput{TaskID: "task-1", UserID: "user-1", Action: "write"}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}
