package httpgateway

import (
	"context"
	"net"
	"net/http"

	"github.com/stablyai/orca-go/common/tenant"
	"github.com/stablyai/orca-go/services/api-gateway/internal/adapter/wscompat"
	"github.com/stablyai/orca-go/services/api-gateway/internal/usecase"
)

// CookieSessionValidator resolves identity from the orca_session cookie via
// a REAL auth-service.ValidateSession call — internal/adapter/authclient's
// implementation. Same interface shape as wscompat.SessionValidator
// (deliberately — both consume the same real validator, see main.go).
type CookieSessionValidator interface {
	ValidateCookie(ctx context.Context, r *http.Request) (wscompat.Identity, error)
}

type contextKey struct{ name string }

var identityContextKey = &contextKey{"api-gateway-identity"}

func withIdentity(ctx context.Context, id usecase.Identity) context.Context {
	return context.WithValue(ctx, identityContextKey, id)
}

// identityFromContext returns the Identity a prior authMiddleware run
// resolved for this request. Exported-in-package for the route handlers
// (usage_routes.go) and the WS bridge handler to read.
func identityFromContext(ctx context.Context) (usecase.Identity, bool) {
	id, ok := ctx.Value(identityContextKey).(usecase.Identity)
	return id, ok
}

// authMiddleware runs ahead of every route this router serves, per
// api-gateway.md §9: "session/JWT validation... before a request reaches
// any internal service".
//
// Real cookie sessions are validated for real (cookieValidator, against
// auth-service.ValidateSession) — the orca_session cookie is a raw session
// token, never a JWT, so usecase.AuthValidator's unverified-JWT parse
// always failed against it (found live 2026-08-17, alongside the same bug
// in wscompat — see docs/execution-plan.md §0). Falls back to
// usecase.AuthValidator's placeholder path ONLY for a bearer JWT
// (mobile/CLI) — that half is still not production-safe, see
// usecase.AuthValidator's doc comment; cookieValidator being nil is also
// tolerated (falls straight back to the placeholder for everything) so
// this middleware doesn't hard-require auth-service to be reachable at
// router-construction time.
func authMiddleware(v *usecase.AuthValidator, cookieValidator CookieSessionValidator) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Resolve the real client IP once, at the edge (TASK-BE-023 /
			// CR-RBAC-005), and stash it on ctx via tenant.WithClientIP so
			// every downstream gatewaygrpc.AttachIdentity call for this
			// request picks it up automatically (see that function's doc
			// comment) — no per-route-handler change needed. Deliberately
			// r.RemoteAddr only, not X-Forwarded-For/X-Real-IP: this
			// codebase has no trusted-proxy allowlist today, and a
			// client-supplied header would let a caller forge the IP that
			// ends up on its own audit trail.
			ctx := tenant.WithClientIP(r.Context(), clientIPFromRemoteAddr(r.RemoteAddr))

			if cookieValidator != nil {
				if id, err := cookieValidator.ValidateCookie(ctx, r); err == nil {
					// Role included — same bug class found live in
					// wscompat.Registry.Dispatch (CR-DS-006 Phase 2): this
					// literal silently dropped id.Role, which would have
					// broken any REST route gated the same way
					// devServer.approve/etc. are over the WS channel path.
					next.ServeHTTP(w, r.WithContext(withIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID, Role: id.Role})))
					return
				}
			}
			identity, err := v.Validate(r)
			if err != nil {
				writeJSONError(w, http.StatusUnauthorized, "UNAUTHENTICATED", err.Error())
				return
			}
			next.ServeHTTP(w, r.WithContext(withIdentity(ctx, identity)))
		})
	}
}

// clientIPFromRemoteAddr strips the port off http.Request.RemoteAddr
// ("host:port", per net/http's doc comment on that field) — falls back to
// the raw value verbatim if it isn't in host:port form (e.g. a test harness
// setting a bare IP), rather than discarding a usable value.
func clientIPFromRemoteAddr(remoteAddr string) string {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		return remoteAddr
	}
	return host
}

// rateLimitMiddleware runs after authMiddleware so it can key on the
// resolved tenant ID — per-tenant token-bucket decisioning
// (internal/usecase/rate_limit.go), per api-gateway.md §9's "rate
// limiting... ahead of routing".
func rateLimitMiddleware(rl *usecase.RateLimiter) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			identity, _ := identityFromContext(r.Context())
			if !rl.Allow(identity.TenantID) {
				writeJSONError(w, http.StatusTooManyRequests, "RATE_LIMITED", "rate limit exceeded for this tenant")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
