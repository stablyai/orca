package oauth

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/stablyai/orca-go/services/auth-service/internal/domain"
	"github.com/stablyai/orca-go/services/auth-service/internal/usecase"
)

// defaultOidcScope requests the three standard OIDC claims
// LoginOrProvisionSsoUser's account-collision policy needs: sub (identity),
// email + email_verified (the collision check itself), and name.
const defaultOidcScope = "openid email profile"

// OidcConfig is one OIDC-compliant provider's endpoints + credentials.
// cmd/server/main.go's composition root builds one instance for Google
// (fixed well-known endpoints, no discovery call — Google's env var list
// gives it no DISCOVERY_URL) and one for generic/self-hosted OIDC
// (Keycloak-compatible; endpoints resolved once at startup via
// FetchDiscoveryDocument against SSO_OIDC_DISCOVERY_URL).
type OidcConfig struct {
	AuthorizeURL string
	TokenURL     string
	UserInfoURL  string
	ClientID     string
	ClientSecret string
	// Scope defaults to defaultOidcScope when empty.
	Scope string
}

// OidcClient implements usecase.SsoExchanger for any spec-compliant OIDC
// provider — one generic client used for both Google and Keycloak/generic-
// OIDC (they're both spec-compliant OIDC providers; only their endpoints
// differ, and those live in Config).
type OidcClient struct {
	httpClient *http.Client
	provider   domain.SsoProvider
	cfg        OidcConfig
}

// NewOidc returns an OidcClient tagged with provider (so
// VerifiedSsoIdentity.Provider is set correctly even before
// complete_sso_login.go's state-derived override runs). A nil httpClient
// defaults to http.DefaultClient.
func NewOidc(httpClient *http.Client, provider domain.SsoProvider, cfg OidcConfig) *OidcClient {
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	if cfg.Scope == "" {
		cfg.Scope = defaultOidcScope
	}
	return &OidcClient{httpClient: httpClient, provider: provider, cfg: cfg}
}

var _ usecase.SsoExchanger = (*OidcClient)(nil)

func (c *OidcClient) AuthorizationURL(state, redirectURI, codeChallenge string) string {
	q := url.Values{}
	q.Set("client_id", c.cfg.ClientID)
	q.Set("redirect_uri", redirectURI)
	q.Set("response_type", "code")
	q.Set("scope", c.cfg.Scope)
	q.Set("state", state)
	q.Set("code_challenge", codeChallenge)
	q.Set("code_challenge_method", "S256")
	sep := "?"
	if strings.Contains(c.cfg.AuthorizeURL, "?") {
		sep = "&"
	}
	return c.cfg.AuthorizeURL + sep + q.Encode()
}

type oidcTokenResponse struct {
	AccessToken      string `json:"access_token"`
	Error            string `json:"error"`
	ErrorDescription string `json:"error_description"`
}

type oidcUserInfo struct {
	Subject       string `json:"sub"`
	Email         string `json:"email"`
	EmailVerified bool   `json:"email_verified"`
	Name          string `json:"name"`
	// Groups requires the deployment's IdP (e.g. Keycloak) to have a
	// "groups" client scope/mapper enabled on the client used here — a
	// config note, not a code gap. Absent from the response when not
	// configured; left nil, not an error (CR-RBAC-003/TASK-BE-007).
	Groups []string `json:"groups"`
}

// ExchangeAndVerify exchanges code (+ PKCE verifier) for an access token at
// TokenURL, then calls UserInfoURL (Bearer-authenticated) to resolve
// sub/email/email_verified/name — see this package's doc comment for why
// this is a userinfo REST call rather than local id_token JWT verification.
func (c *OidcClient) ExchangeAndVerify(ctx context.Context, code, redirectURI, codeVerifier string) (usecase.VerifiedSsoIdentity, error) {
	form := url.Values{}
	form.Set("client_id", c.cfg.ClientID)
	form.Set("client_secret", c.cfg.ClientSecret)
	form.Set("code", code)
	form.Set("redirect_uri", redirectURI)
	form.Set("grant_type", "authorization_code")
	form.Set("code_verifier", codeVerifier)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.cfg.TokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return usecase.VerifiedSsoIdentity{}, fmt.Errorf("oauth: build oidc token exchange request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return usecase.VerifiedSsoIdentity{}, fmt.Errorf("oauth: oidc token exchange request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return usecase.VerifiedSsoIdentity{}, fmt.Errorf("oauth: oidc token exchange: unexpected status %d", resp.StatusCode)
	}
	var tok oidcTokenResponse
	if err := json.NewDecoder(resp.Body).Decode(&tok); err != nil {
		return usecase.VerifiedSsoIdentity{}, fmt.Errorf("oauth: decode oidc token exchange response: %w", err)
	}
	if tok.Error != "" {
		return usecase.VerifiedSsoIdentity{}, fmt.Errorf("oauth: oidc provider rejected code exchange: %s: %s", tok.Error, tok.ErrorDescription)
	}
	if tok.AccessToken == "" {
		return usecase.VerifiedSsoIdentity{}, fmt.Errorf("oauth: oidc token exchange response had no access_token")
	}

	infoReq, err := http.NewRequestWithContext(ctx, http.MethodGet, c.cfg.UserInfoURL, nil)
	if err != nil {
		return usecase.VerifiedSsoIdentity{}, fmt.Errorf("oauth: build oidc userinfo request: %w", err)
	}
	infoReq.Header.Set("Authorization", "Bearer "+tok.AccessToken)
	infoReq.Header.Set("Accept", "application/json")

	infoResp, err := c.httpClient.Do(infoReq)
	if err != nil {
		return usecase.VerifiedSsoIdentity{}, fmt.Errorf("oauth: oidc userinfo request failed: %w", err)
	}
	defer func() { _ = infoResp.Body.Close() }()
	if infoResp.StatusCode != http.StatusOK {
		return usecase.VerifiedSsoIdentity{}, fmt.Errorf("oauth: oidc userinfo request: unexpected status %d", infoResp.StatusCode)
	}
	var info oidcUserInfo
	if err := json.NewDecoder(infoResp.Body).Decode(&info); err != nil {
		return usecase.VerifiedSsoIdentity{}, fmt.Errorf("oauth: decode oidc userinfo response: %w", err)
	}
	if info.Subject == "" {
		return usecase.VerifiedSsoIdentity{}, fmt.Errorf("oauth: oidc userinfo response had no sub")
	}

	return usecase.VerifiedSsoIdentity{
		Provider:      c.provider,
		Subject:       info.Subject,
		Email:         info.Email,
		EmailVerified: info.EmailVerified,
		Name:          info.Name,
		Groups:        info.Groups,
	}, nil
}

// discoveryDocument is the subset of RFC-compliant
// /.well-known/openid-configuration this codebase needs — endpoints only,
// no full metadata modeling.
type discoveryDocument struct {
	AuthorizationEndpoint string `json:"authorization_endpoint"`
	TokenEndpoint         string `json:"token_endpoint"`
	UserinfoEndpoint      string `json:"userinfo_endpoint"`
}

// FetchDiscoveryDocument resolves a generic OIDC provider's authorize/
// token/userinfo endpoints from its discovery URL — called once at
// cmd/server/main.go startup for SSO_OIDC_DISCOVERY_URL, not per-request.
// A ~15-line plain GET + JSON-decode, not a library, matching this
// package's doc comment on why no OIDC client dependency is added here.
func FetchDiscoveryDocument(ctx context.Context, httpClient *http.Client, discoveryURL string) (authorizeURL, tokenURL, userInfoURL string, err error) {
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, discoveryURL, nil)
	if err != nil {
		return "", "", "", fmt.Errorf("oauth: build oidc discovery request: %w", err)
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return "", "", "", fmt.Errorf("oauth: oidc discovery request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return "", "", "", fmt.Errorf("oauth: oidc discovery request: unexpected status %d", resp.StatusCode)
	}
	var doc discoveryDocument
	if err := json.NewDecoder(resp.Body).Decode(&doc); err != nil {
		return "", "", "", fmt.Errorf("oauth: decode oidc discovery document: %w", err)
	}
	if doc.AuthorizationEndpoint == "" || doc.TokenEndpoint == "" || doc.UserinfoEndpoint == "" {
		return "", "", "", fmt.Errorf("oauth: oidc discovery document at %q is missing a required endpoint", discoveryURL)
	}
	return doc.AuthorizationEndpoint, doc.TokenEndpoint, doc.UserinfoEndpoint, nil
}
