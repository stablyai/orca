package usecase

import (
	"context"
	"testing"

	"google.golang.org/grpc/codes"

	"github.com/stablyai/orca-go/common/tenant"
	"github.com/stablyai/orca-go/services/orchestration-service/internal/domain"
)

func TestFailDispatch_RealFailure_RecordsAndIncrements(t *testing.T) {
	repo := &fakeDispatchContextRepository{
		byID: map[string]domain.DispatchContext{
			"dc-1": {ID: "dc-1", TenantID: "tenant-1", Handle: "terminal-3", Status: domain.DispatchStatusDispatched},
		},
	}
	uc := NewFailDispatch(repo)
	ctx := tenant.WithTenantID(context.Background(), "tenant-1")

	// codes.Internal (13) is not one of the transport-classified codes —
	// ClassifyDispatchFailure treats it as a real dispatch failure.
	out, err := uc.Execute(ctx, FailDispatchInput{
		DispatchContextID: "dc-1",
		ErrorMessage:      "agent exited with code 1",
		GRPCStatusCode:    uint32(codes.Internal),
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !out.Recorded {
		t.Fatal("want Recorded=true for a real dispatch failure")
	}
	if out.Context.FailureCount != 1 {
		t.Errorf("want FailureCount=1, got %d", out.Context.FailureCount)
	}
	if out.Context.Status != domain.DispatchStatusFailed {
		t.Errorf("want Status=failed, got %q", out.Context.Status)
	}
	if out.Context.LastFailure != "agent exited with code 1" {
		t.Errorf("want LastFailure set from ErrorMessage, got %q", out.Context.LastFailure)
	}
}

func TestFailDispatch_TransportFailure_DoesNotRecord(t *testing.T) {
	repo := &fakeDispatchContextRepository{
		recordFailureFunc: func(tenantID, dispatchContextID, reason string) (domain.DispatchContext, error) {
			t.Fatal("repo must not be written to for a transport-classified failure")
			return domain.DispatchContext{}, nil
		},
	}
	uc := NewFailDispatch(repo)
	ctx := tenant.WithTenantID(context.Background(), "tenant-1")

	for _, code := range []codes.Code{codes.Unavailable, codes.DeadlineExceeded} {
		out, err := uc.Execute(ctx, FailDispatchInput{
			DispatchContextID: "dc-1",
			ErrorMessage:      "connection reset",
			GRPCStatusCode:    uint32(code),
		})
		if err != nil {
			t.Fatalf("unexpected error for code %v: %v", code, err)
		}
		if out.Recorded {
			t.Errorf("want Recorded=false for transport code %v", code)
		}
	}
}

func TestFailDispatch_TripsCircuitBreakerAtThreshold(t *testing.T) {
	repo := &fakeDispatchContextRepository{
		byID: map[string]domain.DispatchContext{
			"dc-1": {ID: "dc-1", TenantID: "tenant-1", Handle: "terminal-3", Status: domain.DispatchStatusDispatched, FailureCount: 2},
		},
	}
	uc := NewFailDispatch(repo)
	ctx := tenant.WithTenantID(context.Background(), "tenant-1")

	out, err := uc.Execute(ctx, FailDispatchInput{
		DispatchContextID: "dc-1",
		ErrorMessage:      "agent exited with code 1",
		GRPCStatusCode:    uint32(codes.Internal),
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out.Context.Status != domain.DispatchStatusCircuitBroken {
		t.Errorf("want Status=circuit_broken at the 3rd failure, got %q", out.Context.Status)
	}
}

func TestFailDispatch_NotFound(t *testing.T) {
	repo := &fakeDispatchContextRepository{}
	uc := NewFailDispatch(repo)
	ctx := tenant.WithTenantID(context.Background(), "tenant-1")

	_, err := uc.Execute(ctx, FailDispatchInput{
		DispatchContextID: "dc-missing",
		ErrorMessage:      "boom",
		GRPCStatusCode:    uint32(codes.Internal),
	})
	if err == nil {
		t.Fatal("expected an error for an unknown dispatch context id")
	}
}

func TestFailDispatch_EmptyDispatchContextID_FailsBeforeRepoCall(t *testing.T) {
	repo := &fakeDispatchContextRepository{
		recordFailureFunc: func(tenantID, dispatchContextID, reason string) (domain.DispatchContext, error) {
			t.Fatal("repo must not be called for an empty dispatch_context_id")
			return domain.DispatchContext{}, nil
		},
	}
	uc := NewFailDispatch(repo)
	ctx := tenant.WithTenantID(context.Background(), "tenant-1")

	_, err := uc.Execute(ctx, FailDispatchInput{ErrorMessage: "boom", GRPCStatusCode: uint32(codes.Internal)})
	if err == nil {
		t.Fatal("expected error for empty dispatch_context_id")
	}
}

func TestFailDispatch_RequiresTenantContext(t *testing.T) {
	repo := &fakeDispatchContextRepository{}
	uc := NewFailDispatch(repo)

	_, err := uc.Execute(context.Background(), FailDispatchInput{DispatchContextID: "dc-1"})
	if err == nil {
		t.Fatal("expected an error when no tenant is in context")
	}
}
