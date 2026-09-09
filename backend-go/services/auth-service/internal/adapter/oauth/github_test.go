package oauth

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

// withGitHubTestServers points githubTokenURL/githubUserURL/
// githubUserEmailsURL/githubUserOrgsURL at httptest servers for the duration
// of one test — see github.go's doc comment on why these are
// package-private vars.
func withGitHubTestServers(t *testing.T, tokenURL, userURL, userEmailsURL string) {
	t.Helper()
	withGitHubTestServersAndOrgs(t, tokenURL, userURL, userEmailsURL, "")
}

func withGitHubTestServersAndOrgs(t *testing.T, tokenURL, userURL, userEmailsURL, userOrgsURL string) {
	t.Helper()
	origToken, origUser, origEmails, origOrgs := githubTokenURL, githubUserURL, githubUserEmailsURL, githubUserOrgsURL
	if tokenURL != "" {
		githubTokenURL = tokenURL
	}
	if userURL != "" {
		githubUserURL = userURL
	}
	if userEmailsURL != "" {
		githubUserEmailsURL = userEmailsURL
	}
	if userOrgsURL != "" {
		githubUserOrgsURL = userOrgsURL
	}
	t.Cleanup(func() {
		githubTokenURL, githubUserURL, githubUserEmailsURL, githubUserOrgsURL = origToken, origUser, origEmails, origOrgs
	})
}

func TestGitHubAuthorizationURL_BuildsExpectedQueryParams(t *testing.T) {
	c := NewGitHub(nil, GitHubConfig{ClientID: "cid"})
	got := c.AuthorizationURL("state-123", "https://app.example.com/auth/callback", "challenge-abc")

	u, err := url.Parse(got)
	if err != nil {
		t.Fatalf("parse url: %v", err)
	}
	q := u.Query()
	if q.Get("client_id") != "cid" || q.Get("state") != "state-123" || q.Get("redirect_uri") != "https://app.example.com/auth/callback" {
		t.Errorf("unexpected query params: %v", q)
	}
	if q.Get("code_challenge") != "challenge-abc" || q.Get("code_challenge_method") != "S256" {
		t.Errorf("expected pkce params, got %v", q)
	}
}

func TestGitHubExchangeAndVerify_ReturnsVerifiedIdentity(t *testing.T) {
	tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("expected POST to token endpoint, got %s", r.Method)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"gho_token"}`))
	}))
	defer tokenServer.Close()

	userServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer gho_token" {
			t.Errorf("expected bearer auth, got %q", r.Header.Get("Authorization"))
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":42,"name":"Grace Hopper","email":null}`))
	}))
	defer userServer.Close()

	emailsServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[{"email":"secondary@example.com","primary":false,"verified":true},{"email":"grace@example.com","primary":true,"verified":true}]`))
	}))
	defer emailsServer.Close()

	orgsServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[]`))
	}))
	defer orgsServer.Close()

	withGitHubTestServersAndOrgs(t, tokenServer.URL, userServer.URL, emailsServer.URL, orgsServer.URL)

	c := NewGitHub(nil, GitHubConfig{ClientID: "cid", ClientSecret: "csecret"})
	identity, err := c.ExchangeAndVerify(context.Background(), "auth-code", "https://app.example.com/auth/callback", "verifier")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if identity.Subject != "42" {
		t.Errorf("subject = %q, want %q", identity.Subject, "42")
	}
	if identity.Email != "grace@example.com" || !identity.EmailVerified {
		t.Errorf("expected the verified primary email, got email=%q verified=%v", identity.Email, identity.EmailVerified)
	}
	if identity.Name != "Grace Hopper" {
		t.Errorf("name = %q, want %q", identity.Name, "Grace Hopper")
	}
}

func TestGitHubExchangeAndVerify_OrgMembershipPopulatesGroups(t *testing.T) {
	tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"gho_token"}`))
	}))
	defer tokenServer.Close()

	userServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":42,"name":"Grace Hopper","email":null}`))
	}))
	defer userServer.Close()

	emailsServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[{"email":"grace@example.com","primary":true,"verified":true}]`))
	}))
	defer emailsServer.Close()

	orgsServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer gho_token" {
			t.Errorf("expected bearer auth, got %q", r.Header.Get("Authorization"))
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[{"login":"orca-org"},{"login":"another-org"}]`))
	}))
	defer orgsServer.Close()

	withGitHubTestServersAndOrgs(t, tokenServer.URL, userServer.URL, emailsServer.URL, orgsServer.URL)

	c := NewGitHub(nil, GitHubConfig{ClientID: "cid", ClientSecret: "csecret"})
	identity, err := c.ExchangeAndVerify(context.Background(), "auth-code", "https://app.example.com/auth/callback", "verifier")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := []string{"org:orca-org", "org:another-org"}
	if len(identity.Groups) != len(want) {
		t.Fatalf("groups = %v, want %v", identity.Groups, want)
	}
	for i := range want {
		if identity.Groups[i] != want[i] {
			t.Errorf("groups[%d] = %q, want %q", i, identity.Groups[i], want[i])
		}
	}
}

func TestGitHubExchangeAndVerify_OrgMembershipFailureDegradesToEmptyGroups(t *testing.T) {
	tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"gho_token"}`))
	}))
	defer tokenServer.Close()

	userServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":42,"name":"Grace Hopper","email":null}`))
	}))
	defer userServer.Close()

	emailsServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[{"email":"grace@example.com","primary":true,"verified":true}]`))
	}))
	defer emailsServer.Close()

	// Orgs endpoint returns a server error — the SSO login must still succeed.
	orgsServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer orgsServer.Close()

	withGitHubTestServersAndOrgs(t, tokenServer.URL, userServer.URL, emailsServer.URL, orgsServer.URL)

	c := NewGitHub(nil, GitHubConfig{ClientID: "cid", ClientSecret: "csecret"})
	identity, err := c.ExchangeAndVerify(context.Background(), "auth-code", "https://app.example.com/auth/callback", "verifier")
	if err != nil {
		t.Fatalf("expected login to succeed despite org membership failure, got error: %v", err)
	}
	if len(identity.Groups) != 0 {
		t.Errorf("expected empty Groups on org membership failure, got %v", identity.Groups)
	}
}

func TestGitHubExchangeAndVerify_TokenErrorIsAnError(t *testing.T) {
	tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"error":"bad_verification_code","error_description":"the code has expired"}`))
	}))
	defer tokenServer.Close()
	withGitHubTestServers(t, tokenServer.URL, "", "")

	c := NewGitHub(nil, GitHubConfig{})
	if _, err := c.ExchangeAndVerify(context.Background(), "stale-code", "https://app.example.com/auth/callback", ""); err == nil {
		t.Fatal("expected an error when the provider's token response carries an error field")
	}
}

func TestGitHubExchangeAndVerify_NoVerifiedEmailIsAnError(t *testing.T) {
	tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"gho_token"}`))
	}))
	defer tokenServer.Close()
	userServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":7,"name":"No Email"}`))
	}))
	defer userServer.Close()
	emailsServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[]`))
	}))
	defer emailsServer.Close()
	withGitHubTestServers(t, tokenServer.URL, userServer.URL, emailsServer.URL)

	c := NewGitHub(nil, GitHubConfig{})
	if _, err := c.ExchangeAndVerify(context.Background(), "code", "https://app.example.com/auth/callback", ""); err == nil {
		t.Fatal("expected an error when the github account has no email addresses at all")
	}
}
