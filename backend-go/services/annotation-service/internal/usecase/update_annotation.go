package usecase

import (
	"context"
	"errors"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/common/auditclient"
	"github.com/stablyai/orca-go/common/tenant"
	"github.com/stablyai/orca-go/services/annotation-service/internal/domain"
)

// UpdateAnnotationInput mirrors the gRPC request 1:1. Author-only edit is
// enforced below via OPAClient (data.orca.authz.annotation.allow) — see
// annotation-service.md §9 and this service's README "Known gaps" for the
// actor-role propagation caveat.
type UpdateAnnotationInput struct {
	ID       string
	Content  string
	Resolved bool
}

type UpdateAnnotation struct {
	repo        Repository
	opa         OPAClient
	auditClient *auditclient.Client
}

// NewUpdateAnnotation wires the single OPAClient.Decision call site this
// usecase owns (TASK-BE-021/CR-RBAC-005). auditClient may be nil (e.g.
// existing unit tests that don't care about auditing) — see Execute's
// audit-append comment for the nil-safe, best-effort posture that matches.
func NewUpdateAnnotation(repo Repository, opa OPAClient, auditClient *auditclient.Client) *UpdateAnnotation {
	return &UpdateAnnotation{repo: repo, opa: opa, auditClient: auditClient}
}

func (uc *UpdateAnnotation) Execute(ctx context.Context, in UpdateAnnotationInput) (domain.Annotation, error) {
	tenantID, err := tenant.RequireTenantID(ctx)
	if err != nil {
		return domain.Annotation{}, apperrors.New(apperrors.KindUnauthenticated, "ANNOTATION_NO_TENANT", "no tenant in request context", err)
	}
	actorID, ok := tenant.UserID(ctx)
	if !ok {
		return domain.Annotation{}, apperrors.New(apperrors.KindUnauthenticated, "ANNOTATION_NO_USER", "no user in request context", nil)
	}
	if in.ID == "" {
		return domain.Annotation{}, apperrors.New(apperrors.KindInvalidArgument, "ANNOTATION_ID_REQUIRED", "id is required", nil)
	}
	if in.Content == "" {
		return domain.Annotation{}, apperrors.New(apperrors.KindInvalidArgument, "ANNOTATION_INVALID", domain.ErrEmptyContent.Error(), domain.ErrEmptyContent)
	}

	existing, err := uc.repo.GetAnnotation(ctx, tenantID, in.ID)
	if err != nil {
		if errors.Is(err, domain.ErrAnnotationNotFound) {
			return domain.Annotation{}, apperrors.New(apperrors.KindNotFound, "ANNOTATION_NOT_FOUND", "annotation not found", err)
		}
		return domain.Annotation{}, apperrors.New(apperrors.KindInternal, "ANNOTATION_UPDATE_FAILED", "failed to load annotation", err)
	}

	// actor_role is intentionally "" — this service's request context
	// (common/tenant, populated by grpcmw's TenantExtractionInterceptor)
	// carries only tenant_id/user_id today, no role claim, so the OPA
	// admin-override branch never fires yet. See README "Known gaps".
	allowed, err := uc.opa.Decision(ctx, actorID, existing.AuthorID, "")
	if err != nil {
		return domain.Annotation{}, apperrors.New(apperrors.KindInternal, "ANNOTATION_POLICY_EVAL_FAILED", "failed to evaluate authorization policy", err)
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
		uc.auditClient.Append(ctx, tenantID, actorID, "annotation.update", "annotation:"+in.ID, outcome, ip)
	}

	if !allowed {
		return domain.Annotation{}, apperrors.New(apperrors.KindPermissionDenied, "ANNOTATION_NOT_AUTHOR", "only the annotation's author (or an admin) may edit it", nil)
	}

	updated, err := uc.repo.UpdateAnnotation(ctx, tenantID, in.ID, in.Content, in.Resolved)
	if err != nil {
		if errors.Is(err, domain.ErrAnnotationNotFound) {
			return domain.Annotation{}, apperrors.New(apperrors.KindNotFound, "ANNOTATION_NOT_FOUND", "annotation not found", err)
		}
		return domain.Annotation{}, apperrors.New(apperrors.KindInternal, "ANNOTATION_UPDATE_FAILED", "failed to update annotation", err)
	}
	return updated, nil
}
