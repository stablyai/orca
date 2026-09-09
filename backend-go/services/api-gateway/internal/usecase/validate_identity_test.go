package usecase

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stablyai/orca-go/common/jwtauth"

	"github.com/go-jose/go-jose/v4/jwt"
)

// fakeTransit signs with an in-memory RSA key exactly the way Vault
// Transit would (PKCS#1v1.5 over a SHA-256 digest), the same helper
// common/jwtauth's own tests use, so this exercises AuthValidator against a
// real signed+verified JWT rather than the unverified placeholder it
// replaced.
type fakeTransit struct {
	key     *rsa.PrivateKey
	version int
	pem     string
}

func newFakeTransit(t *testing.T, version int) *fakeTransit {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generating test RSA key: %v", err)
	}
	der, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		t.Fatalf("marshaling public key: %v", err)
	}
	pemBlock := pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})
	return &fakeTransit{key: key, version: version, pem: string(pemBlock)}
}

func (f *fakeTransit) sign(_ context.Context, _ string, input []byte) (string, error) {
	digest := sha256.Sum256(input)
	sig, err := rsa.SignPKCS1v15(rand.Reader, f.key, crypto.SHA256, digest[:])
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("vault:v%d:%s", f.version, base64.StdEncoding.EncodeToString(sig)), nil
}

func (f *fakeTransit) publicKeyVersions(_ context.Context, _ string) (map[int]string, int, error) {
	return map[int]string{f.version: f.pem}, f.version, nil
}

// fakeJWKSClient implements JWKSClient over a single already-resolved kid ->
// key mapping, no network/cache involved — the real caching/fetching
// behavior is covered by authclient.JWKSClient's own tests.
type fakeJWKSClient struct {
	kid string
	key any
	err error
}

func (f *fakeJWKSClient) PublicKey(_ context.Context, kid string) (any, error) {
	if f.err != nil {
		return nil, f.err
	}
	if kid != f.kid {
		return nil, fmt.Errorf("fakeJWKSClient: no key for kid %q", kid)
	}
	return f.key, nil
}

// signedTestToken builds a real RS256 JWT (via a fake Transit signer) plus
// a JWKSClient resolving its kid, so a test can exercise AuthValidator's
// full verify path.
func signedTestToken(t *testing.T, tenantID, subject string, expiry time.Time) (string, *fakeJWKSClient) {
	t.Helper()
	transit := newFakeTransit(t, 1)
	signer := jwtauth.NewTransitSigner("jwt-signing", transit.sign, transit.publicKeyVersions)

	claims := jwtauth.Claims{
		Claims: jwt.Claims{
			Issuer:   jwtauth.Issuer,
			Subject:  subject,
			IssuedAt: jwt.NewNumericDate(time.Now()),
			Expiry:   jwt.NewNumericDate(expiry),
		},
		TenantID: tenantID,
	}
	token, err := jwtauth.Sign(context.Background(), signer, claims)
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}

	jwks, err := signer.PublicJWKS(context.Background())
	if err != nil {
		t.Fatalf("PublicJWKS: %v", err)
	}
	if len(jwks.Keys) != 1 {
		t.Fatalf("expected 1 key, got %d", len(jwks.Keys))
	}
	kid := jwks.Keys[0].KeyID
	return token, &fakeJWKSClient{kid: kid, key: jwks.Keys[0].Key}
}

func TestAuthValidator_ValidBearerToken(t *testing.T) {
	token, jwks := signedTestToken(t, "tenant-1", "user-1", time.Now().Add(time.Hour))
	v := NewAuthValidator(jwks)

	r := httptest.NewRequest(http.MethodGet, "/v1/usage/daily", nil)
	r.Header.Set("Authorization", "Bearer "+token)

	id, err := v.Validate(r)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if id.TenantID != "tenant-1" || id.UserID != "user-1" {
		t.Fatalf("got Identity{%q, %q}, want {tenant-1, user-1}", id.TenantID, id.UserID)
	}
}

func TestAuthValidator_SessionCookieFallback(t *testing.T) {
	token, jwks := signedTestToken(t, "tenant-2", "user-2", time.Now().Add(time.Hour))
	v := NewAuthValidator(jwks)

	r := httptest.NewRequest(http.MethodGet, "/v1/usage/daily", nil)
	r.AddCookie(&http.Cookie{Name: SessionCookieName, Value: token})

	id, err := v.Validate(r)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if id.TenantID != "tenant-2" || id.UserID != "user-2" {
		t.Fatalf("got Identity{%q, %q}, want {tenant-2, user-2}", id.TenantID, id.UserID)
	}
}

func TestAuthValidator_NoCredential(t *testing.T) {
	v := NewAuthValidator(&fakeJWKSClient{})
	r := httptest.NewRequest(http.MethodGet, "/v1/usage/daily", nil)

	if _, err := v.Validate(r); err != ErrNoCredential {
		t.Fatalf("got error %v, want ErrNoCredential", err)
	}
}

func TestAuthValidator_MalformedToken(t *testing.T) {
	v := NewAuthValidator(&fakeJWKSClient{})
	r := httptest.NewRequest(http.MethodGet, "/v1/usage/daily", nil)
	r.Header.Set("Authorization", "Bearer not-a-jwt")

	if _, err := v.Validate(r); err != ErrMalformedToken {
		t.Fatalf("got error %v, want ErrMalformedToken", err)
	}
}

func TestAuthValidator_TamperedSignatureRejected(t *testing.T) {
	token, jwks := signedTestToken(t, "tenant-1", "user-1", time.Now().Add(time.Hour))
	v := NewAuthValidator(jwks)

	r := httptest.NewRequest(http.MethodGet, "/v1/usage/daily", nil)
	r.Header.Set("Authorization", "Bearer "+token[:len(token)-4]+"abcd")

	if _, err := v.Validate(r); err != ErrSignatureVerificationFailed {
		t.Fatalf("got error %v, want ErrSignatureVerificationFailed", err)
	}
}

func TestAuthValidator_ExpiredTokenRejected(t *testing.T) {
	token, jwks := signedTestToken(t, "tenant-1", "user-1", time.Now().Add(-time.Hour))
	v := NewAuthValidator(jwks)

	r := httptest.NewRequest(http.MethodGet, "/v1/usage/daily", nil)
	r.Header.Set("Authorization", "Bearer "+token)

	if _, err := v.Validate(r); err != ErrSignatureVerificationFailed {
		t.Fatalf("got error %v, want ErrSignatureVerificationFailed", err)
	}
}

func TestAuthValidator_UnknownKidRejected(t *testing.T) {
	token, _ := signedTestToken(t, "tenant-1", "user-1", time.Now().Add(time.Hour))
	// A JWKSClient that never resolves any kid — simulates the token's kid
	// not matching anything auth-service currently publishes.
	v := NewAuthValidator(&fakeJWKSClient{kid: "some-other-kid", key: nil})

	r := httptest.NewRequest(http.MethodGet, "/v1/usage/daily", nil)
	r.Header.Set("Authorization", "Bearer "+token)

	if _, err := v.Validate(r); err != ErrKeyLookupFailed {
		t.Fatalf("got error %v, want ErrKeyLookupFailed", err)
	}
}

// fakeRevocationChecker implements RevocationChecker with a configurable
// per-jti revoked set, and counts calls per jti — for
// TestAuthValidator_CachesRevocationCheckWithinTTL.
type fakeRevocationChecker struct {
	revoked map[string]bool
	err     error
	calls   map[string]int
}

func newFakeRevocationChecker() *fakeRevocationChecker {
	return &fakeRevocationChecker{revoked: make(map[string]bool), calls: make(map[string]int)}
}

func (f *fakeRevocationChecker) IsRevoked(_ context.Context, jti string) (bool, error) {
	f.calls[jti]++
	if f.err != nil {
		return false, f.err
	}
	return f.revoked[jti], nil
}

// tokenWithJTI is signedTestToken plus an explicit jti claim, needed for
// the revocation-check tests below (signedTestToken itself never sets one).
func tokenWithJTI(t *testing.T, tenantID, subject, jti string, expiry time.Time) (string, *fakeJWKSClient) {
	t.Helper()
	transit := newFakeTransit(t, 1)
	signer := jwtauth.NewTransitSigner("jwt-signing", transit.sign, transit.publicKeyVersions)

	claims := jwtauth.Claims{
		Claims: jwt.Claims{
			Issuer:   jwtauth.Issuer,
			Subject:  subject,
			IssuedAt: jwt.NewNumericDate(time.Now()),
			Expiry:   jwt.NewNumericDate(expiry),
			ID:       jti,
		},
		TenantID: tenantID,
	}
	token, err := jwtauth.Sign(context.Background(), signer, claims)
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}
	jwks, err := signer.PublicJWKS(context.Background())
	if err != nil {
		t.Fatalf("PublicJWKS: %v", err)
	}
	return token, &fakeJWKSClient{kid: jwks.Keys[0].KeyID, key: jwks.Keys[0].Key}
}

// TestAuthValidator_RevocationCheckerNilSkipsCheck is a regression guard:
// a JWT unrelated to CR-CLI-002's domain revocation (Revocation left
// unconfigured, its zero value) must validate exactly as before this
// feature existed.
func TestAuthValidator_RevocationCheckerNilSkipsCheck(t *testing.T) {
	token, jwks := signedTestToken(t, "tenant-1", "user-1", time.Now().Add(time.Hour))
	v := NewAuthValidator(jwks) // Revocation left nil

	r := httptest.NewRequest(http.MethodGet, "/v1/usage/daily", nil)
	r.Header.Set("Authorization", "Bearer "+token)

	if _, err := v.Validate(r); err != nil {
		t.Fatalf("unexpected error with Revocation nil: %v", err)
	}
}

func TestAuthValidator_RevokedTokenRejected(t *testing.T) {
	token, jwks := tokenWithJTI(t, "tenant-1", "user-1", "jti-revoked", time.Now().Add(time.Hour))
	v := NewAuthValidator(jwks)
	checker := newFakeRevocationChecker()
	checker.revoked["jti-revoked"] = true
	v.Revocation = checker

	r := httptest.NewRequest(http.MethodGet, "/v1/usage/daily", nil)
	r.Header.Set("Authorization", "Bearer "+token)

	if _, err := v.Validate(r); err != ErrTokenRevoked {
		t.Fatalf("got error %v, want ErrTokenRevoked", err)
	}
}

// TestAuthValidator_CachesRevocationCheckWithinTTL asserts the mandatory
// TTL cache property (CR-CLI-002/BE-CLI-SOL-002 §2C) end-to-end at the
// layer that actually implements it — authclient.RevocationClient — not
// here: this package (usecase) cannot import authclient without creating
// an import cycle (authclient's session_validator.go imports wscompat,
// which imports usecase for *usecase.AuthValidator — see wscompat.Handler's
// BearerAuth field, TASK-BE-CLI-001). See
// authclient.TestRevocationClient_CachesWithinTTL for the real assertion
// against production caching code, backed by a fake
// authv1.AuthServiceClient. What IS verified here, at this layer, is that
// AuthValidator.Validate calls v.Revocation.IsRevoked exactly once per
// Validate call (never more, never speculatively) — the precondition that
// makes RevocationClient's own cache effective at all.
func TestAuthValidator_CachesRevocationCheckWithinTTL(t *testing.T) {
	token, jwks := tokenWithJTI(t, "tenant-1", "user-1", "jti-cached", time.Now().Add(time.Hour))
	v := NewAuthValidator(jwks)
	checker := newFakeRevocationChecker()
	v.Revocation = checker

	r := httptest.NewRequest(http.MethodGet, "/v1/usage/daily", nil)
	r.Header.Set("Authorization", "Bearer "+token)
	if _, err := v.Validate(r); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got := checker.calls["jti-cached"]; got != 1 {
		t.Fatalf("IsRevoked called %d times for one Validate call, want exactly 1", got)
	}
}

func TestAuthValidator_MissingClaimsRejected(t *testing.T) {
	// A token signed with an empty subject fails claims validation the
	// same way a forged-but-verifiable token missing tenant_id/sub would.
	token, jwks := signedTestToken(t, "", "", time.Now().Add(time.Hour))
	v := NewAuthValidator(jwks)

	r := httptest.NewRequest(http.MethodGet, "/v1/usage/daily", nil)
	r.Header.Set("Authorization", "Bearer "+token)

	if _, err := v.Validate(r); err != ErrMissingIdentityClaims {
		t.Fatalf("got error %v, want ErrMissingIdentityClaims", err)
	}
}
