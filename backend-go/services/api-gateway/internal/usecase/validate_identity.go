package usecase

import (
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/stablyai/orca-go/common/jwtauth"
)

// Identity is the tenant/user identity resolved from a validated
// credential — the only thing downstream code should carry, never a raw
// token (api-gateway.md §9: "identity propagation, not process
// boundaries").
type Identity struct {
	TenantID string
	UserID   string
	// Role is the caller's global role ("admin"/"user") — added for
	// CR-DS-006 Phase 2, and now populated on both auth paths: the
	// cookie/session path (authclient.SessionValidator) and, since
	// CR-RBAC-002 (BE-SOL-002/TASK-BE-004), AuthValidator.Validate's
	// bearer-JWT path too (claims.Role, once jwtauth.Claims started
	// carrying it). Empty for a JWT minted before that change (no "role"
	// claim) — not an error, just an absent claim; see common/tenant.Role's
	// doc comment for the fail-closed contract every caller must honor.
	Role string
}

var (
	// ErrNoCredential means neither an Authorization: Bearer header nor the
	// session cookie was present.
	ErrNoCredential = errors.New("authvalidator: no bearer token or session cookie present")
	// ErrMalformedToken means a credential was present but isn't
	// structurally a JWT (three dot-separated, base64url segments) or its
	// "kid" header couldn't be read.
	ErrMalformedToken = errors.New("authvalidator: malformed JWT")
	// ErrMissingIdentityClaims means the JWT verified but lacked the claims
	// needed to resolve an Identity.
	ErrMissingIdentityClaims = errors.New("authvalidator: token missing tenant_id/sub claims")
	// ErrKeyLookupFailed means the token's "kid" didn't resolve to a known
	// auth-service signing key (unknown kid, or the JWKS fetch itself
	// failed with nothing usable cached — see authclient.JWKSClient).
	ErrKeyLookupFailed = errors.New("authvalidator: could not resolve signing key for token")
	// ErrSignatureVerificationFailed means a signing key was found but the
	// token's signature (or its exp/iat/iss) didn't validate against it.
	ErrSignatureVerificationFailed = errors.New("authvalidator: signature verification failed")
	// ErrTokenRevoked means the JWT verified fine but its jti has been
	// revoked (CR-CLI-002/TASK-BE-CLI-005) — only reachable when Revocation
	// is configured (see AuthValidator.Revocation's doc comment).
	ErrTokenRevoked = errors.New("authvalidator: token has been revoked")
)

// SessionCookieName is the HTTP-only browser session cookie, SameSite=strict
// + Secure always on per api-gateway.md §9 (issued by auth-service; this
// service only reads it).
const SessionCookieName = "orca_session"

// AuthValidator resolves the caller's tenant/user Identity from an inbound
// HTTP request by verifying a short-lived RS256 JWT (mobile/CLI bearer
// token, or a JWT-shaped session-cookie value) against auth-service's JWKS
// — real RS256 signature verification via common/jwtauth, not the
// unverified claim extraction this replaced (Epic D). The browser's real
// orca_session cookie is a raw opaque token, never a JWT — resolving that
// is authclient.SessionValidator's job (a real ValidateSession RPC), which
// authMiddleware/wsbridge.Handler both try FIRST; this validator is the
// fallback for callers that actually present a bearer JWT.
type AuthValidator struct {
	jwks JWKSClient
	// Revocation checks a verified JWT's jti against auth-service's
	// domain-revocation list (CR-CLI-002/TASK-BE-CLI-005) — nil-tolerant
	// and set AFTER construction (see main.go), not a NewAuthValidator
	// parameter: this field is optional (a deployment with no CLI-token
	// revocation wired keeps today's exact behavior), and threading it
	// through the constructor would force every one of NewAuthValidator's
	// many existing call sites (main.go + every wsbridge/wscompat/
	// httpgateway/usecase test double) to change for a feature most of
	// them don't exercise.
	Revocation RevocationChecker
}

// NewAuthValidator returns an AuthValidator that verifies bearer/cookie
// JWTs against jwks (see internal/adapter/authclient.JWKSClient for the
// real implementation).
func NewAuthValidator(jwks JWKSClient) *AuthValidator {
	return &AuthValidator{jwks: jwks}
}

// Validate extracts a bearer token from the Authorization header, falling
// back to the session cookie, then verifies it as a real RS256 JWT against
// auth-service's JWKS: resolve "kid" -> fetch the matching public key ->
// verify signature + exp/iat/iss -> require tenant_id/sub. Fails closed at
// every step — no partial-trust path.
func (v *AuthValidator) Validate(r *http.Request) (Identity, error) {
	token := bearerToken(r)
	if token == "" {
		token = cookieToken(r)
	}
	if token == "" {
		return Identity{}, ErrNoCredential
	}

	kid, err := jwtauth.KeyID(token)
	if err != nil {
		return Identity{}, ErrMalformedToken
	}

	key, err := v.jwks.PublicKey(r.Context(), kid)
	if err != nil {
		return Identity{}, ErrKeyLookupFailed
	}

	claims, err := jwtauth.VerifyWithKey(key, token)
	if err != nil {
		return Identity{}, ErrSignatureVerificationFailed
	}

	if claims.TenantID == "" || claims.Subject == "" {
		return Identity{}, ErrMissingIdentityClaims
	}

	if v.Revocation != nil {
		// Fail-closed: an error checking revocation is treated the same as
		// "revoked" — a transient auth-service outage must never fall back
		// to trusting an otherwise-valid JWT that could have been revoked
		// moments ago (the whole point of this check). See
		// RevocationChecker's doc comment for the caching that keeps this
		// affordable per-request.
		revoked, err := v.Revocation.IsRevoked(r.Context(), claims.ID)
		if err != nil {
			return Identity{}, fmt.Errorf("authvalidator: revocation check failed: %w", err)
		}
		if revoked {
			return Identity{}, ErrTokenRevoked
		}
	}

	return Identity{TenantID: claims.TenantID, UserID: claims.Subject, Role: claims.Role}, nil
}

func bearerToken(r *http.Request) string {
	h := r.Header.Get("Authorization")
	const prefix = "Bearer "
	if len(h) > len(prefix) && strings.EqualFold(h[:len(prefix)], prefix) {
		return strings.TrimSpace(h[len(prefix):])
	}
	return ""
}

func cookieToken(r *http.Request) string {
	c, err := r.Cookie(SessionCookieName)
	if err != nil || c.Value == "" {
		return ""
	}
	return c.Value
}
