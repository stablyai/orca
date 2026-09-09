// Package jwtauth is the shared RS256 JWT signing/verification code Epic D
// needs on both ends of the auth-service <-> api-gateway chain: auth-service
// signs via TransitSigner (Vault Transit-backed, private key never in
// process memory), api-gateway verifies via Verify against the JWKS
// auth-service publishes. One implementation shared by both sides means the
// claim shape and signing/verification semantics can never silently drift
// between issuer and verifier.
package jwtauth

import (
	jose "github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"
)

// Issuer is the standard "iss" claim every auth-service-issued JWT carries,
// and the value Verify checks it against.
const Issuer = "auth-service"

// Algorithm is the one signature algorithm this system issues and accepts,
// per specs/backend-go/architecture/04-tech-stack.md and auth-service.md
// §3/§6/§9 (both explicit — not a default picked here).
const Algorithm = jose.RS256

// Claims is this system's JWT payload: go-jose's standard registered claims
// (iss/sub/aud/exp/iat/jti) plus the one private claim every verifier
// needs — tenant_id — which api-gateway.AuthValidator has always read
// (previously without verifying the token was ever signed).
type Claims struct {
	jwt.Claims
	TenantID string `json:"tenant_id,omitempty"`
	// Role is the caller's global role ("admin"/"user") at token-issuance
	// time — added so a bearer-JWT-authenticated caller propagates the same
	// role claim the cookie/session path already does (BE-SOL-002).
	Role string `json:"role,omitempty"`
}
