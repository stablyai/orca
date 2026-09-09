// Package interceptors holds automation-service-local gRPC unary
// interceptors — ones that apply to this service only, as opposed to
// common/grpcmw's shared, every-service stack. See
// RequireTenantForExternalTrigger's doc comment for why this package
// exists instead of extending common/grpcmw.
package interceptors

import (
	"context"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/stablyai/orca-go/common/tenant"

	automationv1 "github.com/stablyai/orca-go/proto/gen/go/orca/automation/v1"
)

// RequireTenantForExternalTrigger — TASK-BE-AUTO-008/CR-AUTO-005. Gates
// ONLY HandleExternalTrigger (every other RPC on this service passes
// through untouched); rejects with PermissionDenied, before the usecase
// layer ever runs, when the request carries no tenant identity at all.
//
// This is DELIBERATELY narrower than CR-AUTO-005's original "service-to-
// service auth" framing. Real investigation before writing this
// (TASK-BE-AUTO-008's own required Bước 1) found:
//
//  1. No mTLS/service-identity/service-token pattern for gRPC
//     service-to-service calls exists anywhere reusable in backend-go yet.
//     The one candidate — credential-broker-service's plain
//     `x-orca-service-id` gRPC metadata header — is explicitly documented
//     in that service's own README ("Known gaps") as NOT real mTLS/SPIFFE
//     identity, and as of Epic B (2026-08-17) literally no caller in the
//     whole codebase sets that header. Reusing it here would add a
//     same-caveat header nobody populates — theater, not a real gate — and
//     credential-broker-service's own doc explicitly says services must
//     not extend common/grpcmw to add a shared version of this.
//  2. TASK-BE-AUTO-012 already shipped an api-gateway REST route
//     (`POST /automations/{id}/trigger`) that calls HandleExternalTrigger
//     using the SAME identity-validated, tenant-scoped access every other
//     automation RPC already requires (ListAutomations/UpdateAutomation/
//     RunNow etc.) — cross-tenant triggering is already impossible, same
//     posture as this service's other RPCs, not a defect unique to this
//     one. A hard "reject unless x-orca-service-id is set and allow-
//     listed" gate would have BROKEN that already-shipped, tested route,
//     which sets no such header.
//  3. CR-AUTO-005's 2b (agent-completion signal)/2c (PR-merged) internal
//     callers still don't exist anywhere in the codebase — there is
//     nothing today that actually needs a caller-identity distinction
//     beyond tenant scoping. When one of those lands, it should define
//     its own real requirement (what token, issued by whom) rather than
//     this task guessing one in advance.
//
// What's real and worth doing now: RunNow.Execute (HandleExternalTrigger's
// only delegate) already rejects a missing tenant via
// tenant.RequireTenantID, but only after reaching the usecase layer, and
// with KindUnauthenticated (→ codes.Unauthenticated). Moving that same
// check to the interceptor gives fail-fast rejection (no wasted usecase/
// repository work for a request that can never succeed) and the more
// accurate codes.PermissionDenied ("you have no tenant context, not
// merely unauthenticated") — the literal ask in this task's own "Test
// cases cần cover" list, delivered honestly instead of layered on a
// mechanism nobody else in this codebase actually uses.
func RequireTenantForExternalTrigger() grpc.UnaryServerInterceptor {
	return func(ctx context.Context, req any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
		if info.FullMethod != automationv1.AutomationService_HandleExternalTrigger_FullMethodName {
			return handler(ctx, req)
		}
		if _, err := tenant.RequireTenantID(ctx); err != nil {
			return nil, status.Error(codes.PermissionDenied, "HandleExternalTrigger requires a caller with tenant identity")
		}
		return handler(ctx, req)
	}
}
