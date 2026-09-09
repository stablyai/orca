package usecase

import (
	"context"
	"errors"
	"testing"

	"google.golang.org/grpc"
	"google.golang.org/protobuf/types/known/emptypb"

	"github.com/stablyai/orca-go/common/auditclient"
	"github.com/stablyai/orca-go/common/policy"
	"github.com/stablyai/orca-go/common/tenant"
	"github.com/stablyai/orca-go/services/project-service/internal/adapter/opaclient"
	"github.com/stablyai/orca-go/services/project-service/internal/domain"

	authv1 "github.com/stablyai/orca-go/proto/gen/go/orca/auth/v1"
)

// realBundlePath points at the checked-in orca-authz Rego bundle
// (../../../../policy/orca-authz relative to this package) — the tests
// below deliberately exercise the REAL project.rego/repo.rego evaluation via
// the real opaclient.Client + policy.Evaluator, not a Go reimplementation of
// the rule table or a fake that always returns true. TASK-BE-005/BE-SOL-002:
// this is the one place a permissive fake risks masking exactly the bug
// TASK-BE-003/004 fixed (callerGlobalRole used to be hard-coded to "" —  a
// fake OPA client that always allows would still pass with that bug present).
const realBundlePath = "../../../../policy/orca-authz"

func newRealOPAClient() OPAClient {
	return opaclient.New(policy.NewEvaluator(realBundlePath))
}

func TestRequireProjectAccess_GlobalAdminBypassesMembership(t *testing.T) {
	ctx := tenant.WithUserID(context.Background(), "admin-user")
	ctx = tenant.WithRole(ctx, "admin")
	membership := &fakeProjectRepository{getMembershipErr: domain.ErrMembershipNotFound}

	err := requireProjectAccess(ctx, membership, newRealOPAClient(), "proj-1", projectActionOwnerOnly)
	if err != nil {
		t.Fatalf("expected a global admin with no project membership to be authorized, got: %v", err)
	}
}

// TestRequireProjectAccess_NoRoleClaimStaysDeny proves an absent role claim
// (tenant.WithRole never called — Role(ctx) returns ok=false) is never
// silently treated as admin — the fail-closed contract callerGlobalRole's
// doc comment describes.
func TestRequireProjectAccess_NoRoleClaimStaysDeny(t *testing.T) {
	ctx := tenant.WithUserID(context.Background(), "plain-user")
	membership := &fakeProjectRepository{getMembershipErr: domain.ErrMembershipNotFound}

	err := requireProjectAccess(ctx, membership, newRealOPAClient(), "proj-1", projectActionOwnerOnly)
	if err == nil {
		t.Fatal("expected deny for a caller with no project membership and no role claim")
	}
}

func TestRequireRepoAccess_GlobalAdminBypassesMembership(t *testing.T) {
	ctx := tenant.WithUserID(context.Background(), "admin-user")
	ctx = tenant.WithRole(ctx, "admin")
	projectMembership := &fakeProjectRepository{getMembershipErr: domain.ErrMembershipNotFound}
	repoMembership := &fakeRepoRepository{getMembershipErr: domain.ErrRepoMembershipNotFound}

	err := requireRepoAccess(ctx, projectMembership, repoMembership, newRealOPAClient(), "proj-1", "repo-1", repoActionAdminOnly)
	if err != nil {
		t.Fatalf("expected a global admin with no project/repo membership to be authorized, got: %v", err)
	}
}

// TestRequireRepoAccess_NoRoleClaimStaysDeny mirrors
// TestRequireProjectAccess_NoRoleClaimStaysDeny one tier down.
func TestRequireRepoAccess_NoRoleClaimStaysDeny(t *testing.T) {
	ctx := tenant.WithUserID(context.Background(), "plain-user")
	projectMembership := &fakeProjectRepository{getMembershipErr: domain.ErrMembershipNotFound}
	repoMembership := &fakeRepoRepository{getMembershipErr: domain.ErrRepoMembershipNotFound}

	err := requireRepoAccess(ctx, projectMembership, repoMembership, newRealOPAClient(), "proj-1", "repo-1", repoActionAdminOnly)
	if err == nil {
		t.Fatal("expected deny for a caller with no project/repo membership and no role claim")
	}
}

// --- TASK-BE-019: audit-append on both allow and deny branches ---

// fakeAuthServiceClient stubs AppendAuditEntry only — every other
// AuthServiceClient method is left nil-embedded and unused, mirroring
// common/auditclient/client_test.go's own fake.
type fakeAuthServiceClient struct {
	authv1.AuthServiceClient
	err     error
	calls   int
	lastReq *authv1.AppendAuditEntryRequest
}

func (f *fakeAuthServiceClient) AppendAuditEntry(_ context.Context, in *authv1.AppendAuditEntryRequest, _ ...grpc.CallOption) (*emptypb.Empty, error) {
	f.calls++
	f.lastReq = in
	if f.err != nil {
		return nil, f.err
	}
	return &emptypb.Empty{}, nil
}

// withFakeAuditClient wires fake in as the package-level auditClient for the
// duration of one test, restoring whatever was there before (nil, in every
// other test in this file) on cleanup — package-level state, so tests must
// not run in parallel with each other (none in this file call t.Parallel()).
func withFakeAuditClient(t *testing.T, fake *fakeAuthServiceClient) {
	t.Helper()
	previous := auditClient
	SetAuditClient(auditclient.New(fake))
	t.Cleanup(func() { auditClient = previous })
}

func TestRequireProjectAccess_DeniedCallAppendsExactlyOneDeniedAuditEntry(t *testing.T) {
	fake := &fakeAuthServiceClient{}
	withFakeAuditClient(t, fake)

	ctx := tenant.WithUserID(context.Background(), "plain-user")
	membership := &fakeProjectRepository{getMembershipErr: domain.ErrMembershipNotFound}

	err := requireProjectAccess(ctx, membership, newRealOPAClient(), "proj-1", projectActionOwnerOnly)
	if err == nil {
		t.Fatal("expected deny")
	}
	if fake.calls != 1 {
		t.Fatalf("expected exactly one AppendAuditEntry call, got %d", fake.calls)
	}
	if fake.lastReq.GetOutcome() != "denied" {
		t.Fatalf("expected outcome %q, got %q", "denied", fake.lastReq.GetOutcome())
	}
	if fake.lastReq.GetTarget() != "project:proj-1" {
		t.Fatalf("expected target %q, got %q", "project:proj-1", fake.lastReq.GetTarget())
	}
	if fake.lastReq.GetActorId() != "plain-user" {
		t.Fatalf("expected actor_id %q, got %q", "plain-user", fake.lastReq.GetActorId())
	}
}

func TestRequireProjectAccess_AllowedCallAppendsExactlyOneAllowedAuditEntry(t *testing.T) {
	fake := &fakeAuthServiceClient{}
	withFakeAuditClient(t, fake)

	ctx := tenant.WithUserID(context.Background(), "admin-user")
	ctx = tenant.WithRole(ctx, "admin")
	membership := &fakeProjectRepository{getMembershipErr: domain.ErrMembershipNotFound}

	err := requireProjectAccess(ctx, membership, newRealOPAClient(), "proj-1", projectActionOwnerOnly)
	if err != nil {
		t.Fatalf("expected allow, got: %v", err)
	}
	if fake.calls != 1 {
		t.Fatalf("expected exactly one AppendAuditEntry call, got %d", fake.calls)
	}
	if fake.lastReq.GetOutcome() != "allowed" {
		t.Fatalf("expected outcome %q, got %q", "allowed", fake.lastReq.GetOutcome())
	}
}

// TestRequireProjectAccess_AuditAppendFailureDoesNotAffectDecision proves the
// permission decision is authoritative — a failing audit-append (simulated
// via the fake's err field, which auditclient.Client.Append swallows and
// only logs) must never change requireProjectAccess's own return value.
func TestRequireProjectAccess_AuditAppendFailureDoesNotAffectDecision(t *testing.T) {
	fake := &fakeAuthServiceClient{err: errors.New("boom: auth-service unreachable")}
	withFakeAuditClient(t, fake)

	ctx := tenant.WithUserID(context.Background(), "admin-user")
	ctx = tenant.WithRole(ctx, "admin")
	membership := &fakeProjectRepository{getMembershipErr: domain.ErrMembershipNotFound}

	err := requireProjectAccess(ctx, membership, newRealOPAClient(), "proj-1", projectActionOwnerOnly)
	if err != nil {
		t.Fatalf("expected allow despite audit-append failure, got: %v", err)
	}
	if fake.calls != 1 {
		t.Fatalf("expected the audit-append to still have been attempted once, got %d", fake.calls)
	}
}

func TestRequireRepoAccess_DeniedCallAppendsExactlyOneDeniedAuditEntry(t *testing.T) {
	fake := &fakeAuthServiceClient{}
	withFakeAuditClient(t, fake)

	ctx := tenant.WithUserID(context.Background(), "plain-user")
	projectMembership := &fakeProjectRepository{getMembershipErr: domain.ErrMembershipNotFound}
	repoMembership := &fakeRepoRepository{getMembershipErr: domain.ErrRepoMembershipNotFound}

	err := requireRepoAccess(ctx, projectMembership, repoMembership, newRealOPAClient(), "proj-1", "repo-1", repoActionAdminOnly)
	if err == nil {
		t.Fatal("expected deny")
	}
	if fake.calls != 1 {
		t.Fatalf("expected exactly one AppendAuditEntry call, got %d", fake.calls)
	}
	if fake.lastReq.GetOutcome() != "denied" {
		t.Fatalf("expected outcome %q, got %q", "denied", fake.lastReq.GetOutcome())
	}
	if fake.lastReq.GetTarget() != "repo:repo-1" {
		t.Fatalf("expected target %q, got %q", "repo:repo-1", fake.lastReq.GetTarget())
	}
}

func TestRequireRepoAccess_AllowedCallAppendsExactlyOneAllowedAuditEntry(t *testing.T) {
	fake := &fakeAuthServiceClient{}
	withFakeAuditClient(t, fake)

	ctx := tenant.WithUserID(context.Background(), "admin-user")
	ctx = tenant.WithRole(ctx, "admin")
	projectMembership := &fakeProjectRepository{getMembershipErr: domain.ErrMembershipNotFound}
	repoMembership := &fakeRepoRepository{getMembershipErr: domain.ErrRepoMembershipNotFound}

	err := requireRepoAccess(ctx, projectMembership, repoMembership, newRealOPAClient(), "proj-1", "repo-1", repoActionAdminOnly)
	if err != nil {
		t.Fatalf("expected allow, got: %v", err)
	}
	if fake.calls != 1 {
		t.Fatalf("expected exactly one AppendAuditEntry call, got %d", fake.calls)
	}
	if fake.lastReq.GetOutcome() != "allowed" {
		t.Fatalf("expected outcome %q, got %q", "allowed", fake.lastReq.GetOutcome())
	}
}
