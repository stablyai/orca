// Package usecase — see classify_dispatch_failure_test.go and
// BE-SOL-STORAGE-003.md's appended "Investigation result: TASK-BE-STORAGE-011"
// section for the full investigation this file's shape is based on.
//
// Summary of that investigation (do not re-derive without reading it first):
// orchestration-service has no gRPC client to infra-fleet-service and no
// FailDispatch usecase/RPC/caller exists anywhere in this codebase today
// (confirmed via gitnexus impact() returning "not found" for FailDispatch,
// and zero upstream callers of the one related domain method,
// DispatchContext.RecordFailure). BE-SOL-STORAGE-003 §4's
// domain.ConnectionStatus-based classification therefore cannot be wired to
// a real caller in this task — that connectionStatus signal simply is not
// available at any call site that exists in this service. Per the task's
// explicit fallback, this file classifies on the one signal that IS always
// available without a new cross-service RPC: the standard gRPC status code
// (or context error) coming back from the relay call itself.
package usecase

import (
	"context"
	"errors"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// FailureOrigin classifies why a dispatch attempt failed, so a caller can
// decide whether the failure should count toward
// dispatch_contexts.failure_count (via FailDispatch) or be left alone
// because the underlying transport — not the dispatch itself — is what
// failed.
type FailureOrigin int

const (
	// FailureOriginUnknown is returned only for a nil error — callers
	// should not reach ClassifyDispatchFailure without an error in hand.
	FailureOriginUnknown FailureOrigin = iota

	// FailureOriginTransport means the relay call itself could not reach
	// the agent (gRPC Unavailable) or timed out at the transport level
	// (DeadlineExceeded/context.DeadlineExceeded). BE-SOL-STORAGE-003 §4
	// wants this case to NOT trip FailDispatch while the connection is
	// merely degraded and may still reconnect within its grace period.
	//
	// Known limitation (documented, not silently assumed): without
	// connections.status this collapses BE-SOL-STORAGE-003 §4's
	// "degraded" and "closed" rows into one bucket, and cannot separate
	// "transport down" from row 3's "agent still connected but slow to
	// answer this one RPC" (also DeadlineExceeded) — both are real,
	// acknowledged gaps of this interim signal, not oversights. Closing
	// them requires the cross-service connection-status lookup that
	// BE-SOL-STORAGE-003 §4 assumes and that this task was explicitly
	// told not to build.
	FailureOriginTransport

	// FailureOriginDispatchReal is any other error: the agent connection
	// was fine but the dispatch/execution itself failed. FailDispatch
	// should be called for this case, matching today's behavior.
	FailureOriginDispatchReal
)

// ClassifyDispatchFailure classifies a dispatch-attempt error as a
// transport problem (do not fail the dispatch context) or a real dispatch
// failure (do fail it), using only signals that exist today: err's gRPC
// status code, or context.DeadlineExceeded. See the package doc comment
// above for why this — not a domain.ConnectionStatus parameter — is the
// input this function accepts.
func ClassifyDispatchFailure(err error) FailureOrigin {
	if err == nil {
		return FailureOriginUnknown
	}

	if errors.Is(err, context.DeadlineExceeded) {
		return FailureOriginTransport
	}

	if st, ok := status.FromError(err); ok {
		switch st.Code() {
		case codes.Unavailable, codes.DeadlineExceeded:
			return FailureOriginTransport
		}
	}

	return FailureOriginDispatchReal
}
