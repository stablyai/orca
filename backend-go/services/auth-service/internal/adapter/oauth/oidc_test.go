package oauth

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/stablyai/orca-go/services/auth-service/internal/domain"
)

func TestOidcAuthorizationURL_BuildsExpectedQueryParams(t *testing.T) {
	c := NewOidc(nil, domain.SsoProviderOIDC, OidcConfig{AuthorizeURL: "https://idp.example.com/auth", ClientID: "cid"})
	got := c.AuthorizationURL("state-123", "https://app.example.com/auth/callback", "challenge-abc")

	u, err := url.Parse(got)
	if err != nil {
		t.Fatalf("parse url: %v", err)
	}
	q := u.Query()
	if q.Get("client_id") != "cid" || q.Get("state") != "state-123" || q.Get("redirect_uri") != "https://app.example.com/auth/callback" {
		t.Errorf("unexpected query params: %v", q)
	}
	if q.Get("scope") != defaultOidcScope {
		t.Errorf("scope = %q, want default %q", q.Get("scope"), defaultOidcScope)
	}
	if q.Get("code_challenge") != "challenge-abc" || q.Get("code_challenge_method") != "S256" {
		t.Errorf("expected pkce params, got %v", q)
	}
}

func TestOidcExchangeAndVerify_ReturnsVerifiedIdentity(t *testing.T) {
	var gotForm url.Values
	tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		gotForm = r.PostForm
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"at-123","id_token":"unused"}`))
	}))
	defer tokenServer.Close()

	userInfoServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer at-123" {
			t.Errorf("expected bearer auth, got %q", r.Header.Get("Authorization"))
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"sub":"idp-sub-1","email":"grace@example.com","email_verified":true,"name":"Grace Hopper"}`))
	}))
	defer userInfoServer.Close()

	c := NewOidc(nil, domain.SsoProviderOIDC, OidcConfig{TokenURL: tokenServer.URL, UserInfoURL: userInfoServer.URL, ClientID: "cid", ClientSecret: "csecret"})
	identity, err := c.ExchangeAndVerify(context.Background(), "auth-code", "https://app.example.com/auth/callback", "verifier-value")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if gotForm.Get("code_verifier") != "verifier-value" {
		t.Errorf("expected code_verifier to be forwarded to the token endpoint, form = %v", gotForm)
	}
	if identity.Subject != "idp-sub-1" || identity.Email != "grace@example.com" || !identity.EmailVerified || identity.Name != "Grace Hopper" {
		t.Errorf("unexpected identity: %+v", identity)
	}
	if identity.Provider != domain.SsoProviderOIDC {
		t.Errorf("provider = %q, want %q", identity.Provider, domain.SsoProviderOIDC)
	}
}

func TestOidcExchangeAndVerify_ParsesGroupsClaimWhenPresent(t *testing.T) {
	tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"at-123"}`))
	}))
	defer tokenServer.Close()
	userInfoServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"sub":"idp-sub-3","email":"grace@example.com","email_verified":true,"name":"Grace Hopper","groups":["orca-admins","orca-engineering"]}`))
	}))
	defer userInfoServer.Close()

	c := NewOidc(nil, domain.SsoProviderOIDC, OidcConfig{TokenURL: tokenServer.URL, UserInfoURL: userInfoServer.URL})
	identity, err := c.ExchangeAndVerify(context.Background(), "code", "https://app.example.com/auth/callback", "verifier")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := []string{"orca-admins", "orca-engineering"}
	if len(identity.Groups) != len(want) || identity.Groups[0] != want[0] || identity.Groups[1] != want[1] {
		t.Errorf("groups = %v, want %v", identity.Groups, want)
	}
}

func TestOidcExchangeAndVerify_AbsentGroupsClaimDoesNotError(t *testing.T) {
	tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"at-123"}`))
	}))
	defer tokenServer.Close()
	userInfoServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"sub":"idp-sub-4","email":"grace@example.com","email_verified":true,"name":"Grace Hopper"}`))
	}))
	defer userInfoServer.Close()

	c := NewOidc(nil, domain.SsoProviderOIDC, OidcConfig{TokenURL: tokenServer.URL, UserInfoURL: userInfoServer.URL})
	identity, err := c.ExchangeAndVerify(context.Background(), "code", "https://app.example.com/auth/callback", "verifier")
	if err != nil {
		t.Fatalf("unexpected error for a provider that sends no groups claim: %v", err)
	}
	if len(identity.Groups) != 0 {
		t.Errorf("expected no groups, got %v", identity.Groups)
	}
}

func TestOidcExchangeAndVerify_UnverifiedEmailIsPropagated(t *testing.T) {
	tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"at-123"}`))
	}))
	defer tokenServer.Close()
	userInfoServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"sub":"idp-sub-2","email":"unverified@example.com","email_verified":false}`))
	}))
	defer userInfoServer.Close()

	c := NewOidc(nil, domain.SsoProviderGoogle, OidcConfig{TokenURL: tokenServer.URL, UserInfoURL: userInfoServer.URL})
	identity, err := c.ExchangeAndVerify(context.Background(), "code", "https://app.example.com/auth/callback", "verifier")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if identity.EmailVerified {
		t.Error("expected EmailVerified=false to be propagated from the provider, not silently upgraded")
	}
}

func TestOidcExchangeAndVerify_TokenErrorIsAnError(t *testing.T) {
	tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"error":"invalid_grant","error_description":"code expired"}`))
	}))
	defer tokenServer.Close()

	c := NewOidc(nil, domain.SsoProviderOIDC, OidcConfig{TokenURL: tokenServer.URL})
	if _, err := c.ExchangeAndVerify(context.Background(), "code", "https://app.example.com/auth/callback", "verifier"); err == nil {
		t.Fatal("expected an error when the provider's token response carries an error field")
	}
}

func TestFetchDiscoveryDocument_ParsesEndpoints(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"authorization_endpoint":"https://idp.example.com/auth","token_endpoint":"https://idp.example.com/token","userinfo_endpoint":"https://idp.example.com/userinfo"}`))
	}))
	defer server.Close()

	authorizeURL, tokenURL, userInfoURL, err := FetchDiscoveryDocument(context.Background(), nil, server.URL)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if authorizeURL != "https://idp.example.com/auth" || tokenURL != "https://idp.example.com/token" || userInfoURL != "https://idp.example.com/userinfo" {
		t.Errorf("unexpected endpoints: authorize=%q token=%q userinfo=%q", authorizeURL, tokenURL, userInfoURL)
	}
}

func TestFetchDiscoveryDocument_MissingEndpointIsAnError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"authorization_endpoint":"https://idp.example.com/auth"}`))
	}))
	defer server.Close()

	if _, _, _, err := FetchDiscoveryDocument(context.Background(), nil, server.URL); err == nil {
		t.Fatal("expected an error for a discovery document missing token_endpoint/userinfo_endpoint")
	}
}
