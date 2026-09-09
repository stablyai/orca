package usecase

import (
	"context"
	"time"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/services/auth-service/internal/domain"
)

type QueryAuditLogInput struct {
	TenantID string
	Since    time.Time
	// ActorID/Action/Outcome are optional filters (TASK-BE-016) — zero
	// value on each means "no filter," matching AuditRepository.Query's own
	// empty-means-no-filter convention.
	ActorID   string
	Action    string
	Outcome   domain.Outcome
	PageToken string
	PageSize  int32
}

type QueryAuditLogOutput struct {
	Entries       []domain.AuditEntry
	NextPageToken string
}

// QueryAuditLog is an admin-console, read-only operation — the log itself
// is never mutated through this or any other usecase method
// (domain.AuditEntry's doc comment).
type QueryAuditLog struct {
	users UserRepository
	audit AuditRepository
	opa   OPAClient
}

func NewQueryAuditLog(users UserRepository, audit AuditRepository, opa OPAClient) *QueryAuditLog {
	return &QueryAuditLog{users: users, audit: audit, opa: opa}
}

func (uc *QueryAuditLog) Execute(ctx context.Context, in QueryAuditLogInput) (QueryAuditLogOutput, error) {
	if _, err := requireAdminActor(ctx, uc.users, uc.opa); err != nil {
		return QueryAuditLogOutput{}, err
	}

	pageSize := in.PageSize
	if pageSize <= 0 || pageSize > 200 {
		pageSize = 50
	}

	entries, next, err := uc.audit.Query(ctx, in.TenantID, in.Since, in.ActorID, in.Action, in.Outcome, in.PageToken, pageSize)
	if err != nil {
		return QueryAuditLogOutput{}, apperrors.New(apperrors.KindInternal, "AUTH_AUDIT_QUERY_FAILED", "failed to query audit log", err)
	}
	return QueryAuditLogOutput{Entries: entries, NextPageToken: next}, nil
}
