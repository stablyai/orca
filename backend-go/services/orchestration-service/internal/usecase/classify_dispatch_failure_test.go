package usecase

import (
	"context"
	"errors"
	"testing"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// TestClassifyDispatchFailure_UnavailableReturnsTransport covers the
// "relay could not reach the agent" case — BE-SOL-STORAGE-003 §4's
// "connection degraded" row, observed here as a gRPC Unavailable status
// since no connections.status signal reaches this service (see the
// investigation note in classify_dispatch_failure.go).
func TestClassifyDispatchFailure_UnavailableReturnsTransport(t *testing.T) {
	err := status.Error(codes.Unavailable, "relay: connection refused")

	origin := ClassifyDispatchFailure(err)

	if origin != FailureOriginTransport {
		t.Fatalf("got %v, want FailureOriginTransport", origin)
	}
}

// TestClassifyDispatchFailure_GRPCDeadlineExceededReturnsTransport covers
// a gRPC-status-coded timeout talking to the relay.
func TestClassifyDispatchFailure_GRPCDeadlineExceededReturnsTransport(t *testing.T) {
	err := status.Error(codes.DeadlineExceeded, "relay: context deadline exceeded")

	origin := ClassifyDispatchFailure(err)

	if origin != FailureOriginTransport {
		t.Fatalf("got %v, want FailureOriginTransport", origin)
	}
}

// TestClassifyDispatchFailure_ContextDeadlineExceededReturnsTransport
// covers the plain context.DeadlineExceeded a caller may see directly
// (e.g. ctx.Err()) without it having been wrapped into a gRPC status.
func TestClassifyDispatchFailure_ContextDeadlineExceededReturnsTransport(t *testing.T) {
	origin := ClassifyDispatchFailure(context.DeadlineExceeded)

	if origin != FailureOriginTransport {
		t.Fatalf("got %v, want FailureOriginTransport", origin)
	}
}

// TestClassifyDispatchFailure_WrappedContextDeadlineExceededReturnsTransport
// confirms errors.Is-style wrapping is honored, not just exact equality.
func TestClassifyDispatchFailure_WrappedContextDeadlineExceededReturnsTransport(t *testing.T) {
	err := errors.Join(errors.New("agent-worker: exec"), context.DeadlineExceeded)

	origin := ClassifyDispatchFailure(err)

	if origin != FailureOriginTransport {
		t.Fatalf("got %v, want FailureOriginTransport", origin)
	}
}

// TestClassifyDispatchFailure_GenericErrorReturnsDispatchReal covers
// BE-SOL-STORAGE-003 §4's "agent returned a real execution error while
// established" row — must still call FailDispatch.
func TestClassifyDispatchFailure_GenericErrorReturnsDispatchReal(t *testing.T) {
	err := errors.New("agent-worker: task exited with code 1")

	origin := ClassifyDispatchFailure(err)

	if origin != FailureOriginDispatchReal {
		t.Fatalf("got %v, want FailureOriginDispatchReal", origin)
	}
}

// TestClassifyDispatchFailure_OtherGRPCStatusReturnsDispatchReal covers a
// gRPC error whose code is neither Unavailable nor DeadlineExceeded (e.g.
// the agent itself rejected the request) — real failure, not transport.
func TestClassifyDispatchFailure_OtherGRPCStatusReturnsDispatchReal(t *testing.T) {
	err := status.Error(codes.Internal, "agent-worker: internal error")

	origin := ClassifyDispatchFailure(err)

	if origin != FailureOriginDispatchReal {
		t.Fatalf("got %v, want FailureOriginDispatchReal", origin)
	}
}

// TestClassifyDispatchFailure_NilErrorReturnsUnknown documents the
// contract for the no-error input a well-behaved caller should never
// actually pass.
func TestClassifyDispatchFailure_NilErrorReturnsUnknown(t *testing.T) {
	origin := ClassifyDispatchFailure(nil)

	if origin != FailureOriginUnknown {
		t.Fatalf("got %v, want FailureOriginUnknown", origin)
	}
}
