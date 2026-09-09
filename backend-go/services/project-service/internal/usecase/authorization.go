package usecase

import (
	"context"
	"errors"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/common/auditclient"
	"github.com/stablyai/orca-go/common/tenant"
	"github.com/stablyai/orca-go/services/project-service/internal/domain"
)

// projectActionOwnerOnly/projectActionAnyMember are the two action values
// project.rego's action_roles table keys on — see that file for the exact
// mapping. Every OPA-gated usecase in this package passes one of these two
// constants to requireProjectAccess.
const (
	// projectActionOwnerOnly gates UpdateProject/DeleteProject/AddMember/
	// RebindDevServer per project-service.md §9, plus this service's
	// judgment-call extension to AddRepo/RemoveRepo/ReorderRepos — a
	// repo/worktree belongs to exactly one project, so the project's
	// owner-or-admin rule is the natural fit for its catalog mutations. See
	// this service's README "Known gaps" for the RPCs deliberately left
	// out of that extension (worktree mutation RPCs, ProjectGroup CRUD).
	projectActionOwnerOnly = "owner_only"
	// projectActionAnyMember gates GetProject/ListRepos/ListWorktrees —
	// any membership (owner/member/viewer) or global admin.
	projectActionAnyMember = "any_member"
)

// repoAction* are the values repo.rego's action_roles table keys on — the
// repo-scoped functional-role tier (admin/developer/lead), layered on top
// of the project-scoped owner/member tier above. Every repo.rego-gated
// usecase passes one of these three constants to requireRepoAccess.
const (
	// repoActionAdminOnly gates RemoveRepo/UpdateRepo/granting or revoking
	// another user's functional role on this repo.
	repoActionAdminOnly = "repo_admin_only"
	// repoActionLeadOrAdmin gates ReorderRepos.
	repoActionLeadOrAdmin = "repo_lead_or_admin"
	// repoActionAnyFunctionalRole gates read/visibility access to a
	// specific repo for a project member who isn't its owner.
	repoActionAnyFunctionalRole = "repo_any_functional_role"
)

// callerGlobalRole resolves the acting user's system-wide role for
// project.rego's admin-override branch, from the role claim api-gateway
// attaches via grpcmw.MetadataRole (common/tenant.WithRole) — see
// common/tenant.Role's doc comment for the fail-closed contract: an absent
// claim (ok==false) is treated as "", never as an implicit allow.
func callerGlobalRole(ctx context.Context) string {
	role, _ := tenant.Role(ctx)
	return role
}

// auditClient is TASK-BE-018's shared audit-append client, wired once by
// main.go's composition root via SetAuditClient (TASK-BE-019/CR-RBAC-005).
// requireProjectAccess/requireRepoAccess are free functions with ~28 call
// sites across this package's usecases — threading an *auditclient.Client
// field through every one of those structs' constructors just to reach
// these two functions would be pure plumbing with no other consumer, so
// this package-level singleton is the "package-level wiring point"
// TASK-BE-019 itself allows as an alternative to constructor injection.
// nil until SetAuditClient runs (e.g. most existing unit tests never call
// it), in which case the audit-append is silently skipped — the
// permission decision itself must never depend on this.
var auditClient *auditclient.Client

// SetAuditClient wires the shared audit client into this package. Called
// once, by main.go, before serving traffic.
func SetAuditClient(c *auditclient.Client) {
	auditClient = c
}

// auditDecision appends a best-effort audit entry for an OPA allow/deny
// decision — called from both requireProjectAccess and requireRepoAccess
// right after their opa.Decision/opa.RepoDecision call resolves, on both
// the allowed and denied branches (F32 wants to see both, not just
// denials). Never affects the caller's own return value: Append itself is
// non-blocking (see auditclient.Client.Append's doc comment), and a nil
// auditClient (not yet wired) is a no-op here too.
func auditDecision(ctx context.Context, actorID, action, target string, allowed bool) {
	if auditClient == nil {
		return
	}
	tenantID, _ := tenant.TenantID(ctx)
	ip, _ := tenant.ClientIP(ctx)
	outcome := "denied"
	if allowed {
		outcome = "allowed"
	}
	auditClient.Append(ctx, tenantID, actorID, action, target, outcome, ip)
}

// requireProjectAccess resolves the acting user's membership role in
// projectID (if any) and asks OPA (data.orca.authz.project.allow) whether
// action is authorized for that role — a global admin (once
// callerGlobalRole is wired to a real claim) always passes regardless of
// membership. Fails closed on every error path: a missing actor, a
// membership-lookup failure, or a policy-evaluation error are all treated
// as deny, never as allow — matching auth-service.requireAdminActor's exact
// contract (internal/usecase/authorization.go in that service).
func requireProjectAccess(ctx context.Context, membership MembershipRepository, opa OPAClient, projectID, action string) error {
	actorID, ok := tenant.UserID(ctx)
	if !ok {
		return apperrors.New(apperrors.KindUnauthenticated, "PROJECT_NO_USER", "no user in request context", nil)
	}

	callerProjectRole := ""
	m, err := membership.GetMembership(ctx, projectID, actorID)
	switch {
	case errors.Is(err, domain.ErrMembershipNotFound):
		// No membership row — callerProjectRole stays "". project.rego's
		// action_roles has no "" entry, so this alone can never allow; only
		// a global-admin caller_global_role can still pass.
	case err != nil:
		return apperrors.New(apperrors.KindInternal, "PROJECT_MEMBERSHIP_LOOKUP_FAILED", "failed to resolve caller's project membership", err)
	default:
		callerProjectRole = string(m.Role)
	}

	allowed, err := opa.Decision(ctx, callerProjectRole, callerGlobalRole(ctx), action)
	if err != nil {
		// Fail closed: a policy-evaluation error is never treated as an
		// allow — matching every other OPA call site in this codebase
		// (common/policy.Evaluator's doc comment).
		return apperrors.New(apperrors.KindInternal, "PROJECT_POLICY_EVAL_FAILED", "failed to evaluate authorization policy", err)
	}
	auditDecision(ctx, actorID, action, "project:"+projectID, allowed)
	if !allowed {
		return apperrors.New(apperrors.KindPermissionDenied, "PROJECT_NOT_AUTHORIZED", "caller is not authorized for this action", nil)
	}
	return nil
}

// requireRepoAccess is requireProjectAccess's repo-scoped counterpart: it
// resolves the caller's PROJECT role first (a project owner always passes,
// regardless of any repo_members grant — repo.rego's own bypass rule, kept
// in Go too so a missing/erroring repo-membership lookup can never itself
// deny an owner), then — for a non-owner — resolves their functional role
// on repoID specifically and asks OPA. Fails closed on every error path,
// same contract as requireProjectAccess.
func requireRepoAccess(ctx context.Context, projectMembership MembershipRepository, repoMembership RepoMembershipRepository, opa OPAClient, projectID, repoID, action string) error {
	actorID, ok := tenant.UserID(ctx)
	if !ok {
		return apperrors.New(apperrors.KindUnauthenticated, "PROJECT_NO_USER", "no user in request context", nil)
	}

	callerProjectRole := ""
	pm, err := projectMembership.GetMembership(ctx, projectID, actorID)
	switch {
	case errors.Is(err, domain.ErrMembershipNotFound):
		// No project membership at all — callerProjectRole stays "".
	case err != nil:
		return apperrors.New(apperrors.KindInternal, "PROJECT_MEMBERSHIP_LOOKUP_FAILED", "failed to resolve caller's project membership", err)
	default:
		callerProjectRole = string(pm.Role)
	}

	callerRepoRole := ""
	// Skip the repo-membership lookup entirely for a project owner: their
	// access never depends on it, and a repo with no repo_members rows at
	// all (the common case — repo_members is opt-in, not required) would
	// otherwise report ErrRepoMembershipNotFound on every single owner
	// call for no reason.
	if callerProjectRole != string(domain.ProjectRoleOwner) {
		rm, err := repoMembership.GetRepoMembership(ctx, repoID, actorID)
		switch {
		case errors.Is(err, domain.ErrRepoMembershipNotFound):
			// No functional-role grant on this specific repo — callerRepoRole
			// stays "". repo.rego's action_roles has no "" entry, so this
			// alone can never allow a non-owner through.
		case err != nil:
			return apperrors.New(apperrors.KindInternal, "PROJECT_REPO_MEMBERSHIP_LOOKUP_FAILED", "failed to resolve caller's repo membership", err)
		default:
			callerRepoRole = string(rm.Role)
		}
	}

	allowed, err := opa.RepoDecision(ctx, callerProjectRole, callerRepoRole, callerGlobalRole(ctx), action)
	if err != nil {
		return apperrors.New(apperrors.KindInternal, "PROJECT_POLICY_EVAL_FAILED", "failed to evaluate authorization policy", err)
	}
	auditDecision(ctx, actorID, action, "repo:"+repoID, allowed)
	if !allowed {
		return apperrors.New(apperrors.KindPermissionDenied, "PROJECT_NOT_AUTHORIZED", "caller is not authorized for this action", nil)
	}
	return nil
}
