package usecase

import (
	"context"
	"errors"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/common/tenant"

	"github.com/stablyai/orca-go/services/orchestration-service/internal/domain"
)

// FailDispatchInput mirrors the FailDispatchRequest RPC message.
// ErrorMessage/GRPCStatusCode describe the caller's own failed
// dispatch/relay call — see ClassifyDispatchFailure for exactly how they're
// used to decide transport-vs-real.
type FailDispatchInput struct {
	DispatchContextID string
	ErrorMessage      string
	GRPCStatusCode    uint32
}

// FailDispatch is the real call site TASK-BE-STORAGE-011 built
// ClassifyDispatchFailure for but had nothing to wire it into — see
// docs/backlog/BACKLOG-009-orchestration-service-fail-dispatch-missing.md.
// It exists as a standalone, callable RPC/usecase now; which service ends
// up calling it (once a real agent-dispatch relay call site exists
// somewhere in backend-go) is intentionally left open — see that backlog
// entry's "who calls it" question, not guessed at here.
type FailDispatch struct {
	repo DispatchContextRepository
}

func NewFailDispatch(repo DispatchContextRepository) *FailDispatch {
	return &FailDispatch{repo: repo}
}

// FailDispatchOutput reports both the (possibly unchanged) DispatchContext
// and whether this call actually recorded a failure — a transport-classified
// failure intentionally leaves Context unchanged and Recorded=false rather
// than erroring, since "we chose not to count this" is not a failure of the
// FailDispatch call itself.
type FailDispatchOutput struct {
	Context  domain.DispatchContext
	Recorded bool
}

func (uc *FailDispatch) Execute(ctx context.Context, in FailDispatchInput) (FailDispatchOutput, error) {
	tenantID, err := tenant.RequireTenantID(ctx)
	if err != nil {
		return FailDispatchOutput{}, apperrors.New(apperrors.KindUnauthenticated, "ORCH_NO_TENANT", "no tenant in request context", err)
	}
	if in.DispatchContextID == "" {
		return FailDispatchOutput{}, apperrors.New(apperrors.KindInvalidArgument, "ORCH_EMPTY_DISPATCH_CONTEXT_ID", "dispatch_context_id is required", nil)
	}

	// Reconstruct a comparable gRPC error from the wire fields so this
	// reuses ClassifyDispatchFailure unmodified — see that function's own
	// doc comment for why gRPC status code is the signal it classifies on.
	callErr := status.Error(codes.Code(in.GRPCStatusCode), in.ErrorMessage)
	if ClassifyDispatchFailure(callErr) == FailureOriginTransport {
		// Why: BE-SOL-STORAGE-003 §4 — a transient transport blip must not
		// trip the circuit breaker. No repository write, and deliberately no
		// read-back either (no port exists to fetch by dispatch_context_id
		// alone, only by task or user) — Recorded=false is itself the
		// complete signal the caller needs; Context is left zero-value.
		return FailDispatchOutput{Recorded: false}, nil
	}

	updated, err := uc.repo.RecordDispatchFailure(ctx, tenantID, in.DispatchContextID, in.ErrorMessage)
	if err != nil {
		if errors.Is(err, ErrDispatchContextNotFound) {
			return FailDispatchOutput{}, apperrors.New(apperrors.KindNotFound, "ORCH_DISPATCH_CONTEXT_NOT_FOUND", "dispatch context not found", err)
		}
		return FailDispatchOutput{}, apperrors.New(apperrors.KindInternal, "ORCH_FAIL_DISPATCH_FAILED", "failed to record dispatch failure", err)
	}
	return FailDispatchOutput{Context: updated, Recorded: true}, nil
}
