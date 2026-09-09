package usecase

import (
	"context"

	"github.com/google/uuid"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/services/auth-service/internal/domain"
)

// AppendAuditEntryInput mirrors AppendAuditEntryRequest
// (proto/orca/auth/v1/auth.proto) field-for-field.
type AppendAuditEntryInput struct {
	TenantID  string
	ActorID   string
	Action    string
	Target    string
	Outcome   string
	IPAddress string
}

// AppendAuditEntry is the cross-service audit-ingress usecase (TASK-BE-017):
// project-service/task-service/annotation-service/infra-fleet-service call
// this — via the AppendAuditEntry RPC — to record an entry in
// auth-service's own auth.audit_log, since that table lives only in this
// service's database (bounded-context rule, no other service gets a direct
// connection to it). Deliberately has NO requireAdminActor gate, unlike
// every other admin-console usecase in this file's neighbors: this is a
// service-to-service call, authenticated via mTLS + NetworkPolicy at the
// transport layer (specs/backend-go/architecture/07-security-architecture.md),
// not a user-identity-gated admin action — there is no acting admin user to
// resolve here, only a calling service's own already-authorized decision to
// record.
type AppendAuditEntry struct {
	audit AuditRepository
	clock Clock
}

func NewAppendAuditEntry(audit AuditRepository, clock Clock) *AppendAuditEntry {
	return &AppendAuditEntry{audit: audit, clock: clock}
}

func (uc *AppendAuditEntry) Execute(ctx context.Context, in AppendAuditEntryInput) error {
	if in.TenantID == "" {
		return apperrors.New(apperrors.KindInvalidArgument, "AUTH_AUDIT_NO_TENANT", "tenant_id is required", nil)
	}
	if in.Action == "" {
		return apperrors.New(apperrors.KindInvalidArgument, "AUTH_AUDIT_NO_ACTION", "action is required", nil)
	}

	entry, err := domain.NewAuditEntry(uuid.NewString(), in.TenantID, in.ActorID, in.Action, in.Target, domain.Outcome(in.Outcome), in.IPAddress, uc.clock.Now())
	if err != nil {
		return apperrors.New(apperrors.KindInvalidArgument, "AUTH_AUDIT_INVALID_ENTRY", err.Error(), err)
	}
	if err := uc.audit.Append(ctx, entry); err != nil {
		return apperrors.New(apperrors.KindInternal, "AUTH_AUDIT_APPEND_FAILED", "failed to append audit entry", err)
	}
	return nil
}
