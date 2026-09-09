package usecase

import (
	"context"
	"errors"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/common/auditclient"
	"github.com/stablyai/orca-go/common/tenant"
	"github.com/stablyai/orca-go/services/annotation-service/internal/domain"
)

// DeleteAnnotationInput mirrors the gRPC request 1:1. Author-only delete is
// enforced below via OPAClient (data.orca.authz.annotation.allow) — see
// annotation-service.md §9 and this service's README "Known gaps" for the
// actor-role propagation caveat.
type DeleteAnnotationInput struct {
	ID string
}

type DeleteAnnotation struct {
	repo        Repository
	opa         OPAClient
	auditClient *auditclient.Client
}

// NewDeleteAnnotation wires the single OPAClient.Decision call site this
// usecase owns (TASK-BE-021/CR-RBAC-005). auditClient may be nil (e.g.
// existing unit tests that don't care about auditing) — see Execute's
// audit-append comment for the nil-safe, best-effort posture that matches.
func NewDeleteAnnotation(repo Repository, opa OPAClient, auditClient *auditclient.Client) *DeleteAnnotation {
	return &DeleteAnnotation{repo: repo, opa: opa, auditClient: auditClient}
}

func (uc *DeleteAnnotation) Execute(ctx context.Context, in DeleteAnnotationInput) error {
	tenantID, err := tenant.RequireTenantID(ctx)
	if err != nil {
		return apperrors.New(apperrors.KindUnauthenticated, "ANNOTATION_NO_TENANT", "no tenant in request context", err)
	}
	actorID, ok := tenant.UserID(ctx)
	if !ok {
		return apperrors.New(apperrors.KindUnauthenticated, "ANNOTATION_NO_USER", "no user in request context", nil)
	}
	if in.ID == "" {
		return apperrors.New(apperrors.KindInvalidArgument, "ANNOTATION_ID_REQUIRED", "id is required", nil)
	}

	existing, err := uc.repo.GetAnnotation(ctx, tenantID, in.ID)
	if err != nil {
		if errors.Is(err, domain.ErrAnnotationNotFound) {
			return apperrors.New(apperrors.KindNotFound, "ANNOTATION_NOT_FOUND", "annotation not found", err)
		}
		return apperrors.New(apperrors.KindInternal, "ANNOTATION_DELETE_FAILED", "failed to load annotation", err)
	}

	// actor_role is intentionally "" — see update_annotation.go's Execute
	// for why (no role claim propagated into context yet).
	allowed, err := uc.opa.Decision(ctx, actorID, existing.AuthorID, "")
	if err != nil {
		return apperrors.New(apperrors.KindInternal, "ANNOTATION_POLICY_EVAL_FAILED", "failed to evaluate authorization policy", err)
	}

	// Audit both the allow and deny outcome (F32/TASK-BE-021) — best-effort,
	// never affects the decision itself: Append is non-blocking (see
	// auditclient.Client.Append's doc comment), and a nil auditClient
	// (not wired) is a no-op here too.
	if uc.auditClient != nil {
		ip, _ := tenant.ClientIP(ctx)
		outcome := "denied"
		if allowed {
			outcome = "allowed"
		}
		uc.auditClient.Append(ctx, tenantID, actorID, "annotation.delete", "annotation:"+in.ID, outcome, ip)
	}

	if !allowed {
		return apperrors.New(apperrors.KindPermissionDenied, "ANNOTATION_NOT_AUTHOR", "only the annotation's author (or an admin) may delete it", nil)
	}

	if err := uc.repo.DeleteAnnotation(ctx, tenantID, in.ID); err != nil {
		if errors.Is(err, domain.ErrAnnotationNotFound) {
			return apperrors.New(apperrors.KindNotFound, "ANNOTATION_NOT_FOUND", "annotation not found", err)
		}
		return apperrors.New(apperrors.KindInternal, "ANNOTATION_DELETE_FAILED", "failed to delete annotation", err)
	}
	return nil
}
