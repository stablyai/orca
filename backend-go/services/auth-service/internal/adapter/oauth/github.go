// Package oauth implements usecase.SsoExchanger for GitHub OAuth2 and
// generic OIDC (which also covers Google — see oidc.go's doc comment). No
// external OAuth2/OIDC library is used, matching this codebase's existing
// convention (scm-integration-service's internal/adapter/oauth hand-rolls
// the same authorization-code exchange with plain net/http).
//
// Identity verification is done via a REST userinfo call authenticated
// with the access token this package itself just received directly from
// the provider's token endpoint over TLS — not by verifying an id_token
// JWT's signature locally. GitHub has no id_token concept at all (its
// trust model *is* "call a REST endpoint with the access token"), so this
// keeps GitHub and OIDC on one uniform "exchange code -> call a REST
// endpoint -> read email/sub/name" shape, without needing a JWKS-
// verification dependency in this service.
package oauth

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/stablyai/orca-go/services/auth-service/internal/domain"
	"github.com/stablyai/orca-go/services/auth-service/internal/usecase"
)

// GitHub's real endpoints — vars, not consts, so github_test.go can point
// them at an httptest server for the duration of a test (a standard Go
// package-private test seam; production code never reassigns these).
var (
	githubAuthorizeURL  = "https://github.com/login/oauth/authorize"
	githubTokenURL      = "https://github.com/login/oauth/access_token"
	githubUserURL       = "https://api.github.com/user"
	githubUserEmailsURL = "https://api.github.com/user/emails"
	githubUserOrgsURL   = "https://api.github.com/user/orgs"
)

const githubScope = "read:user user:email"

// GitHubConfig is the client credentials cmd/server/main.go's composition
// root supplies — GitHub's endpoints above are fixed, unlike generic OIDC's
// discovery-resolved ones.
type GitHubConfig struct {
	ClientID     string
	ClientSecret string
}

// GitHubClient implements usecase.SsoExchanger against GitHub's OAuth2 web
// application flow.
type GitHubClient struct {
	httpClient   *http.Client
	clientID     string
	clientSecret string
}

// NewGitHub returns a GitHubClient for cfg. A nil httpClient defaults to
// http.DefaultClient, matching scm-integration-service's oauth.Client.
func NewGitHub(httpClient *http.Client, cfg GitHubConfig) *GitHubClient {
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	return &GitHubClient{httpClient: httpClient, clientID: cfg.ClientID, clientSecret: cfg.ClientSecret}
}

var _ usecase.SsoExchanger = (*GitHubClient)(nil)

// AuthorizationURL builds the URL to redirect the browser to. GitHub's
// OAuth Apps flow predates PKCE and doesn't require it, but code_challenge/
// code_challenge_method are sent regardless (GitHub ignores unrecognized
// query params) so StartSsoLogin's flow stays uniform across every
// provider — it never needs to know which ones actually enforce PKCE.
func (c *GitHubClient) AuthorizationURL(state, redirectURI, codeChallenge string) string {
	q := url.Values{}
	q.Set("client_id", c.clientID)
	q.Set("redirect_uri", redirectURI)
	q.Set("state", state)
	q.Set("scope", githubScope)
	q.Set("code_challenge", codeChallenge)
	q.Set("code_challenge_method", "S256")
	return githubAuthorizeURL + "?" + q.Encode()
}

type githubTokenResponse struct {
	AccessToken      string `json:"access_token"`
	Error            string `json:"error"`
	ErrorDescription string `json:"error_description"`
}

type githubUser struct {
	ID    int64  `json:"id"`
	Name  string `json:"name"`
	Email string `json:"email"` // often empty/null unless the user made it public
}

type githubEmail struct {
	Email    string `json:"email"`
	Primary  bool   `json:"primary"`
	Verified bool   `json:"verified"`
}

type githubOrg struct {
	Login string `json:"login"`
}

// ExchangeAndVerify exchanges code for an access token, then calls GET
// /user + GET /user/emails to resolve the caller's stable numeric id, name,
// and verified primary email (GitHub's /user.email is frequently empty
// unless the user opted to make it public — /user/emails is the reliable
// source of the verified primary address).
func (c *GitHubClient) ExchangeAndVerify(ctx context.Context, code, redirectURI, codeVerifier string) (usecase.VerifiedSsoIdentity, error) {
	form := url.Values{}
	form.Set("client_id", c.clientID)
	form.Set("client_secret", c.clientSecret)
	form.Set("code", code)
	form.Set("redirect_uri", redirectURI)
	if codeVerifier != "" {
		form.Set("code_verifier", codeVerifier)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, githubTokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return usecase.VerifiedSsoIdentity{}, fmt.Errorf("oauth: build github token exchange request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json") // GitHub's token endpoint form-encodes its response unless this is set

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return usecase.VerifiedSsoIdentity{}, fmt.Errorf("oauth: github token exchange request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		return usecase.VerifiedSsoIdentity{}, fmt.Errorf("oauth: github token exchange: unexpected status %d", resp.StatusCode)
	}
	var tok githubTokenResponse
	if err := json.NewDecoder(resp.Body).Decode(&tok); err != nil {
		return usecase.VerifiedSsoIdentity{}, fmt.Errorf("oauth: decode github token exchange response: %w", err)
	}
	if tok.Error != "" {
		return usecase.VerifiedSsoIdentity{}, fmt.Errorf("oauth: github rejected code exchange: %s: %s", tok.Error, tok.ErrorDescription)
	}
	if tok.AccessToken == "" {
		return usecase.VerifiedSsoIdentity{}, fmt.Errorf("oauth: github token exchange response had no access_token")
	}

	user, err := c.fetchUser(ctx, tok.AccessToken)
	if err != nil {
		return usecase.VerifiedSsoIdentity{}, err
	}
	email, verified, err := c.fetchPrimaryVerifiedEmail(ctx, tok.AccessToken)
	if err != nil {
		return usecase.VerifiedSsoIdentity{}, err
	}

	// Org membership is an enhancement to role resolution, not a login
	// precondition — a GitHub API failure here must never fail the whole
	// SSO flow, so degrade to empty Groups instead of propagating the error.
	groups := c.fetchOrgGroups(ctx, tok.AccessToken)

	return usecase.VerifiedSsoIdentity{
		Provider:      domain.SsoProviderGitHub,
		Subject:       strconv.FormatInt(user.ID, 10),
		Email:         email,
		EmailVerified: verified,
		Name:          user.Name,
		Groups:        groups,
	}, nil
}

// fetchOrgGroups returns the caller's GitHub org memberships as
// "org:<login>" strings. Org-level only for now — team-level granularity
// (GET /orgs/{org}/teams/{team}/memberships/{username}) is an N+1-shaped
// call per team and is left as a follow-up, not implemented here. Any
// failure degrades to nil rather than erroring — see the call site's
// comment.
func (c *GitHubClient) fetchOrgGroups(ctx context.Context, accessToken string) []string {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, githubUserOrgsURL, nil)
	if err != nil {
		return nil
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Accept", "application/vnd.github+json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return nil
	}
	var orgs []githubOrg
	if err := json.NewDecoder(resp.Body).Decode(&orgs); err != nil {
		return nil
	}
	groups := make([]string, 0, len(orgs))
	for _, o := range orgs {
		if o.Login != "" {
			groups = append(groups, "org:"+o.Login)
		}
	}
	return groups
}

func (c *GitHubClient) fetchUser(ctx context.Context, accessToken string) (githubUser, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, githubUserURL, nil)
	if err != nil {
		return githubUser{}, fmt.Errorf("oauth: build github user request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Accept", "application/vnd.github+json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return githubUser{}, fmt.Errorf("oauth: github user request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return githubUser{}, fmt.Errorf("oauth: github user request: unexpected status %d", resp.StatusCode)
	}
	var user githubUser
	if err := json.NewDecoder(resp.Body).Decode(&user); err != nil {
		return githubUser{}, fmt.Errorf("oauth: decode github user response: %w", err)
	}
	if user.ID == 0 {
		return githubUser{}, fmt.Errorf("oauth: github user response had no id")
	}
	return user, nil
}

// fetchPrimaryVerifiedEmail returns the caller's primary email and whether
// GitHub reports it verified — the /user/emails list is the only reliable
// source of this (see githubUser.Email's doc comment).
func (c *GitHubClient) fetchPrimaryVerifiedEmail(ctx context.Context, accessToken string) (email string, verified bool, err error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, githubUserEmailsURL, nil)
	if err != nil {
		return "", false, fmt.Errorf("oauth: build github user emails request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Accept", "application/vnd.github+json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return "", false, fmt.Errorf("oauth: github user emails request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return "", false, fmt.Errorf("oauth: github user emails request: unexpected status %d", resp.StatusCode)
	}
	var emails []githubEmail
	if err := json.NewDecoder(resp.Body).Decode(&emails); err != nil {
		return "", false, fmt.Errorf("oauth: decode github user emails response: %w", err)
	}
	for _, e := range emails {
		if e.Primary {
			return e.Email, e.Verified, nil
		}
	}
	if len(emails) > 0 {
		return emails[0].Email, emails[0].Verified, nil
	}
	return "", false, fmt.Errorf("oauth: github account has no email addresses")
}
