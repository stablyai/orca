// Package grpcmw provides the shared gRPC server interceptors every service
// wires into its adapter/grpc/ layer identically: panic recovery, tenant
// context extraction, and request logging. See
// specs/backend-go/architecture/08-inter-service-communication.md
// ("Server-side interceptors... handle: JWT validation, tenant-context
// extraction, OpenTelemetry span creation, structured request logging,
// panic recovery... No service hand-rolls this per-RPC.").
package grpcmw

import (
	"context"
	"log/slog"
	"time"

	"go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"

	"github.com/stablyai/orca-go/common/tenant"
)

// Metadata keys populated by api-gateway (or a caller service) on every
// outbound gRPC call, per architecture/08's rule that tenant scoping travels
// via gRPC metadata, never a message field.
const (
	MetadataTenantID = "x-orca-tenant-id"
	MetadataUserID   = "x-orca-user-id"
	// MetadataRole carries the caller's global role ("admin"/"user") —
	// added for CR-DS-006 Phase 2's admin-gated dev-server-approval RPCs.
	// Only populated end-to-end for the cookie/session auth path today
	// (authclient.SessionValidator) — see common/tenant.Role's doc comment.
	MetadataRole = "x-orca-role"
	// MetadataClientIP carries the caller's real client IP, resolved once
	// at the api-gateway edge (httpgateway.authMiddleware) from the inbound
	// HTTP request — added for CR-RBAC-005/TASK-BE-023 so an internal
	// service's audit call sites can record it (common/tenant.ClientIP)
	// without each one re-deriving it (or trusting its own gRPC peer info,
	// which would just be api-gateway's IP, not the real client's).
	MetadataClientIP = "x-orca-client-ip"
)

// TenantExtractionInterceptor pulls MetadataTenantID/MetadataUserID out of
// incoming gRPC metadata and attaches them to the request context via
// common/tenant, so every downstream usecase/repository call sees them.
//
// This is a placeholder for the real validation path: in production, this
// interceptor's caller-facing counterpart is the JWT/session validation
// done once at api-gateway (which resolves and signs the tenant/user
// identity before it ever reaches an internal service). An internal
// service normally trusts its caller's metadata because mTLS + the service
// mesh's NetworkPolicy already restrict who can call it at all (see
// architecture/07-security-architecture.md). Services that need to
// re-validate a JWT directly (rare — most only need the already-resolved
// tenant/user) should call auth-service's JWKS-validation helper instead of
// trusting metadata blindly; that helper isn't implemented in this scaffold.
func TenantExtractionInterceptor() grpc.UnaryServerInterceptor {
	return func(ctx context.Context, req any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
		md, ok := metadata.FromIncomingContext(ctx)
		if ok {
			if v := md.Get(MetadataTenantID); len(v) > 0 && v[0] != "" {
				ctx = tenant.WithTenantID(ctx, v[0])
			}
			if v := md.Get(MetadataUserID); len(v) > 0 && v[0] != "" {
				ctx = tenant.WithUserID(ctx, v[0])
			}
			if v := md.Get(MetadataRole); len(v) > 0 && v[0] != "" {
				ctx = tenant.WithRole(ctx, v[0])
			}
			if v := md.Get(MetadataClientIP); len(v) > 0 && v[0] != "" {
				ctx = tenant.WithClientIP(ctx, v[0])
			}
		}
		return handler(ctx, req)
	}
}

// RecoveryInterceptor converts a panic in a handler into codes.Internal
// instead of crashing the process — see standards/go-coding-standards.md's
// "no panic in request-handling paths" rule: this is the backstop, not a
// license to skip proper error handling.
func RecoveryInterceptor(logger *slog.Logger) grpc.UnaryServerInterceptor {
	return func(ctx context.Context, req any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (resp any, err error) {
		defer func() {
			if r := recover(); r != nil {
				logger.ErrorContext(ctx, "panic recovered in gRPC handler",
					slog.String("method", info.FullMethod),
					slog.Any("panic", r),
				)
				err = status.Error(codes.Internal, "internal error")
			}
		}()
		return handler(ctx, req)
	}
}

// LoggingInterceptor logs RED-metric-relevant fields (method, duration,
// status) for every unary RPC — the manual half of what
// architecture/09-observability-reliability.md calls "RED metrics on every
// gRPC method by default via interceptor"; the metrics half lives in
// common/tracing (not yet wired in this scaffold — see that package's TODO).
func LoggingInterceptor(logger *slog.Logger) grpc.UnaryServerInterceptor {
	return func(ctx context.Context, req any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
		start := time.Now()
		resp, err := handler(ctx, req)
		attrs := []slog.Attr{
			slog.String("method", info.FullMethod),
			slog.Duration("duration", time.Since(start)),
		}
		if err != nil {
			attrs = append(attrs, slog.String("error", err.Error()), slog.String("code", status.Code(err).String()))
			logger.LogAttrs(ctx, slog.LevelError, "rpc failed", attrs...)
		} else {
			logger.LogAttrs(ctx, slog.LevelInfo, "rpc ok", attrs...)
		}
		return resp, err
	}
}

// ChainUnary composes the standard interceptor stack in the recommended
// order: recovery outermost (must catch panics from everything inside it),
// then tenant extraction (so logging can include tenant_id), then logging.
func ChainUnary(logger *slog.Logger) grpc.ServerOption {
	return grpc.ChainUnaryInterceptor(
		RecoveryInterceptor(logger),
		TenantExtractionInterceptor(),
		LoggingInterceptor(logger),
	)
}

// StatsHandler returns the OTel gRPC stats handler every gRPC-serving
// service passes to grpc.NewServer ALONGSIDE ChainUnary (never instead of
// it, never merged into it) — kept separate specifically so this addition
// never touches ChainUnary's signature, which every one of the 16
// gRPC-serving services calls identically today (impact() confirms
// CRITICAL blast radius: 32 impacted symbols, 16 direct call sites, as of
// TASK-BE-FFT-001). Produces a server-side span per inbound RPC — the
// "one span per hop" half of CR-FFT-001's cross-service trace.
func StatsHandler() grpc.ServerOption {
	return grpc.StatsHandler(otelgrpc.NewServerHandler())
}
