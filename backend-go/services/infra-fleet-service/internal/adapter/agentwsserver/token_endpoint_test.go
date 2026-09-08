package agentwsserver

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stablyai/orca-go/services/infra-fleet-service/internal/domain"
	"github.com/stablyai/orca-go/services/infra-fleet-service/internal/usecase"
)

func newTestIssuer(secret string) (*TokenIssuer, *Registry) {
	registry := NewRegistry(time.Hour)
	issuer := NewTokenIssuer(registry, Config{APISecret: secret, OrcaVersion: "test-version", Port: 6768}, nil, nil, nil)
	return issuer, registry
}

func doRequest(t *testing.T, issuer *TokenIssuer, method, body, bearer string) *httptest.ResponseRecorder {
	t.Helper()
	var reader *bytes.Reader
	if body == "" {
		reader = bytes.NewReader(nil)
	} else {
		reader = bytes.NewReader([]byte(body))
	}
	req := httptest.NewRequest(method, "/api/agent-token", reader)
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	rec := httptest.NewRecorder()
	issuer.ServeHTTP(rec, req)
	return rec
}

func decodeJSON(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decoding response body %q: %v", rec.Body.String(), err)
	}
	return out
}

// TestTokenEndpoint_MissingAPISecret_AlwaysReturns401 is the most important
// test here: fail-secure when ORCA_AGENT_API_SECRET is unset, regardless of
// what Authorization header (if any) the caller sends.
func TestTokenEndpoint_MissingAPISecret_AlwaysReturns401(t *testing.T) {
	issuer, registry := newTestIssuer("") // no secret configured
	t.Cleanup(registry.Stop)

	cases := []struct {
		name   string
		bearer string
	}{
		{"no header", ""},
		{"empty bearer", ""},
		{"guessed admin-style bearer", "1"},
		{"arbitrary bearer", "whatever-secret-someone-guesses"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := doRequest(t, issuer, http.MethodPost, `{}`, tc.bearer)
			if rec.Code != http.StatusUnauthorized {
				t.Fatalf("status = %d, want 401 (fail-secure with no ORCA_AGENT_API_SECRET configured)", rec.Code)
			}
		})
	}
}

func TestTokenEndpoint_WrongBearer_Returns401(t *testing.T) {
	issuer, registry := newTestIssuer("correct-secret")
	t.Cleanup(registry.Stop)

	rec := doRequest(t, issuer, http.MethodPost, `{}`, "wrong-secret")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestTokenEndpoint_MissingAuthorizationHeader_Returns401(t *testing.T) {
	issuer, registry := newTestIssuer("correct-secret")
	t.Cleanup(registry.Stop)

	req := httptest.NewRequest(http.MethodPost, "/api/agent-token", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()
	issuer.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

// TestTokenEndpoint_ValidPOST_DefaultsAndEphemeralTTL covers the default
// devServerId/name, and the default+capped TTL policy for a non-permanent
// token with no ttl given.
func TestTokenEndpoint_ValidPOST_DefaultsAndEphemeralTTL(t *testing.T) {
	issuer, registry := newTestIssuer("s3cr3t")
	t.Cleanup(registry.Stop)

	rec := doRequest(t, issuer, http.MethodPost, `{}`, "s3cr3t")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s, want 200", rec.Code, rec.Body.String())
	}
	body := decodeJSON(t, rec)

	if body["devServerId"] != "dev-local" {
		t.Errorf("devServerId = %v, want dev-local", body["devServerId"])
	}
	if body["name"] != "Dev Server (dev-local)" {
		t.Errorf("name = %v, want 'Dev Server (dev-local)'", body["name"])
	}
	if expiresIn, _ := body["expiresIn"].(float64); expiresIn != 300 {
		t.Errorf("expiresIn = %v, want 300 (default ttl)", body["expiresIn"])
	}
	if body["created"] != true {
		t.Errorf("created = %v, want true", body["created"])
	}
	token, _ := body["token"].(string)
	if !strings.HasPrefix(token, "agt-dev-local-") {
		t.Errorf("token = %q, want prefix agt-dev-local-", token)
	}
	cmd, _ := body["agentCommand"].(string)
	if !strings.Contains(cmd, token) || !strings.Contains(cmd, "AGENT_TOKEN=") {
		t.Errorf("agentCommand = %q, want it to embed the token", cmd)
	}

	// The token must actually be usable — a real slot was registered.
	if !registry.Has(token) {
		t.Error("registered token not found in Registry")
	}
}

// TestTokenEndpoint_TTLIsCappedAt600 covers the "ephemeral: max 10 min"
// cap for a requested ttl above 600s.
func TestTokenEndpoint_TTLIsCappedAt600(t *testing.T) {
	issuer, registry := newTestIssuer("s3cr3t")
	t.Cleanup(registry.Stop)

	rec := doRequest(t, issuer, http.MethodPost, `{"ttl": 999999}`, "s3cr3t")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	body := decodeJSON(t, rec)
	if expiresIn, _ := body["expiresIn"].(float64); expiresIn != 600 {
		t.Errorf("expiresIn = %v, want 600 (capped)", body["expiresIn"])
	}
}

// TestTokenEndpoint_PermanentTTL covers permanent:true → 30-day TTL,
// uncapped by the 600s ephemeral cap even if ttl is also present.
func TestTokenEndpoint_PermanentTTL(t *testing.T) {
	issuer, registry := newTestIssuer("s3cr3t")
	t.Cleanup(registry.Stop)

	rec := doRequest(t, issuer, http.MethodPost, `{"permanent": true, "ttl": 30}`, "s3cr3t")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	body := decodeJSON(t, rec)
	wantSeconds := float64(30 * 24 * 60 * 60)
	if expiresIn, _ := body["expiresIn"].(float64); expiresIn != wantSeconds {
		t.Errorf("expiresIn = %v, want %v (30 days, ignoring ttl for a permanent token)", body["expiresIn"], wantSeconds)
	}
}

// TestTokenEndpoint_CustomDevServerIDAndName covers request fields that
// override the defaults.
func TestTokenEndpoint_CustomDevServerIDAndName(t *testing.T) {
	issuer, registry := newTestIssuer("s3cr3t")
	t.Cleanup(registry.Stop)

	rec := doRequest(t, issuer, http.MethodPost, `{"devServerId":"ds-42","name":"My Box"}`, "s3cr3t")
	body := decodeJSON(t, rec)
	if body["devServerId"] != "ds-42" {
		t.Errorf("devServerId = %v, want ds-42", body["devServerId"])
	}
	if body["name"] != "My Box" {
		t.Errorf("name = %v, want 'My Box'", body["name"])
	}
	token, _ := body["token"].(string)
	if !strings.HasPrefix(token, "agt-ds-42-") {
		t.Errorf("token = %q, want prefix agt-ds-42-", token)
	}
}

// fakeResolverRepo is a minimal usecase.DevServerRepository for exercising
// TokenIssuer's Resolver wiring — only Register/FindByHostAndMode matter
// here, every other method is unreachable from ResolveDirectWebSocketDevServer.
type fakeResolverRepo struct {
	registered []domain.DevServer
}

func (f *fakeResolverRepo) Register(ctx context.Context, ds domain.DevServer) (domain.DevServer, error) {
	f.registered = append(f.registered, ds)
	return ds, nil
}
func (f *fakeResolverRepo) Get(context.Context, string, string) (domain.DevServer, error) {
	return domain.DevServer{}, nil
}
func (f *fakeResolverRepo) List(context.Context, string) ([]domain.DevServer, error) { return nil, nil }
func (f *fakeResolverRepo) FindBySshTarget(context.Context, string, string) (domain.DevServer, bool, error) {
	return domain.DevServer{}, false, nil
}
func (f *fakeResolverRepo) FindByHostAndMode(ctx context.Context, tenantID, host string, mode domain.ConnectionMode) (domain.DevServer, bool, error) {
	return domain.DevServer{}, false, nil // always "not found" — forces Register every call, fine for this test
}
func (f *fakeResolverRepo) UpdateApprovalStatus(context.Context, string, string, domain.DevServerStatus) (domain.DevServer, error) {
	return domain.DevServer{}, nil
}
func (f *fakeResolverRepo) AssignGroup(context.Context, string, string, string) (domain.DevServer, error) {
	return domain.DevServer{}, nil
}

// TestTokenEndpoint_WithResolver_RegistrySlotKeyIsResolvedUUIDNotRawDevServerID
// is the regression guard for the live-verified bug this Resolver wiring
// fixes: 3 real agents connected and handshook successfully while
// infra.dev_servers stayed empty, because Registry tracked the raw
// caller-supplied devServerID string, never a row ApproveDevServer/
// ListDevServers could see. With a Resolver wired, Consume must return the
// resolved row's real UUID, not "ds-42".
func TestTokenEndpoint_WithResolver_RegistrySlotKeyIsResolvedUUIDNotRawDevServerID(t *testing.T) {
	registry := NewRegistry(time.Hour)
	t.Cleanup(registry.Stop)
	repo := &fakeResolverRepo{}
	resolver := usecase.NewResolveDirectWebSocketDevServer(repo)
	issuer := NewTokenIssuer(registry, Config{APISecret: "s3cr3t", OrcaVersion: "test-version", Port: 6768, DefaultTenantID: "tenant-1"}, nil, resolver, nil)

	rec := doRequest(t, issuer, http.MethodPost, `{"devServerId":"ds-42"}`, "s3cr3t")
	body := decodeJSON(t, rec)
	token, _ := body["token"].(string)

	if len(repo.registered) != 1 {
		t.Fatalf("want exactly 1 dev server registered, got %d", len(repo.registered))
	}
	registeredID := repo.registered[0].ID
	if registeredID == "" || registeredID == "ds-42" {
		t.Fatalf("want a generated UUID, got %q", registeredID)
	}
	if repo.registered[0].TenantID != "tenant-1" {
		t.Errorf("want TenantID from Cfg.DefaultTenantID, got %q", repo.registered[0].TenantID)
	}
	if repo.registered[0].Host != "ds-42" {
		t.Errorf("want Host set to the caller's devServerID, got %q", repo.registered[0].Host)
	}

	slotKey, ok := registry.Consume(token)
	if !ok {
		t.Fatal("want a pending slot for the minted token")
	}
	if slotKey != registeredID {
		t.Errorf("registry slot key = %q, want the resolved row's UUID %q — AttachInboundSession would key devserveragent.Client.sessions by the wrong value", slotKey, registeredID)
	}
}

// fakeEphemeralVmRuntimeRepo is a minimal usecase.EphemeralVmRuntimeRepository
// double — only SetEnvironmentID is exercised by TokenIssuer, the rest exist
// solely to satisfy the interface.
type fakeEphemeralVmRuntimeRepo struct {
	// existingRuntimeIDs is the set of ephemeral_vm_runtimes.id values this
	// fake pretends exist for the test's tenant — mirrors the real
	// postgres implementation's "UPDATE ... WHERE id = $2" matching 0 rows
	// when runtimeID isn't one of these (the common case: most devServerID
	// values passed to /api/agent-token are not ephemeral VM runtimes).
	existingRuntimeIDs map[string]bool
	setCalls           []setEnvironmentIDCall
}

type setEnvironmentIDCall struct {
	tenantID, runtimeID, environmentID string
}

func (f *fakeEphemeralVmRuntimeRepo) SetEnvironmentID(_ context.Context, tenantID, runtimeID, environmentID string) (domain.EphemeralVmRuntime, error) {
	f.setCalls = append(f.setCalls, setEnvironmentIDCall{tenantID, runtimeID, environmentID})
	if !f.existingRuntimeIDs[runtimeID] {
		return domain.EphemeralVmRuntime{}, domain.ErrEphemeralVmRuntimeNotFound
	}
	return domain.EphemeralVmRuntime{ID: runtimeID, EnvironmentID: environmentID}, nil
}
func (f *fakeEphemeralVmRuntimeRepo) List(context.Context, string) ([]domain.EphemeralVmRuntime, error) {
	return nil, nil
}
func (f *fakeEphemeralVmRuntimeRepo) Get(context.Context, string, string) (domain.EphemeralVmRuntime, error) {
	return domain.EphemeralVmRuntime{}, nil
}
func (f *fakeEphemeralVmRuntimeRepo) GetByWorkspaceID(context.Context, string, string) (domain.EphemeralVmRuntime, error) {
	return domain.EphemeralVmRuntime{}, nil
}
func (f *fakeEphemeralVmRuntimeRepo) UpdateStatus(context.Context, string, string, string, string, string) (domain.EphemeralVmRuntime, error) {
	return domain.EphemeralVmRuntime{}, nil
}
func (f *fakeEphemeralVmRuntimeRepo) UpdateProvisionResult(context.Context, string, string, string, string, string) (domain.EphemeralVmRuntime, error) {
	return domain.EphemeralVmRuntime{}, nil
}
func (f *fakeEphemeralVmRuntimeRepo) FindDevServerByEnvironmentID(context.Context, string, string) (string, bool, error) {
	return "", false, nil
}

// TestTokenEndpoint_WithResolverAndRuntimes_LinksMatchingEphemeralVmRuntime
// covers TASK-BE-EVM-011's decision: when the caller's devServerID happens
// to match a live ephemeral_vm_runtimes.id (the recipe/VM's agent opted into
// the DEV_SERVER_ID=<runtimeID> contract), handlePost writes the newly
// resolved dev_servers.id onto that runtime's environment_id — the only
// place the real UUID exists, since EphemeralVmRelay.Provision's own
// "orca-server" event never carries a dev_server_id.
func TestTokenEndpoint_WithResolverAndRuntimes_LinksMatchingEphemeralVmRuntime(t *testing.T) {
	registry := NewRegistry(time.Hour)
	t.Cleanup(registry.Stop)
	devServerRepo := &fakeResolverRepo{}
	resolver := usecase.NewResolveDirectWebSocketDevServer(devServerRepo)
	runtimes := &fakeEphemeralVmRuntimeRepo{existingRuntimeIDs: map[string]bool{"runtime-abc": true}}
	issuer := NewTokenIssuer(registry, Config{APISecret: "s3cr3t", OrcaVersion: "test-version", Port: 6768, DefaultTenantID: "tenant-1"}, nil, resolver, runtimes)

	doRequest(t, issuer, http.MethodPost, `{"devServerId":"runtime-abc"}`, "s3cr3t")

	if len(runtimes.setCalls) != 1 {
		t.Fatalf("want exactly 1 SetEnvironmentID call, got %d", len(runtimes.setCalls))
	}
	call := runtimes.setCalls[0]
	if call.tenantID != "tenant-1" {
		t.Errorf("tenantID = %q, want tenant-1", call.tenantID)
	}
	if call.runtimeID != "runtime-abc" {
		t.Errorf("runtimeID = %q, want runtime-abc (the caller's devServerID)", call.runtimeID)
	}
	registeredID := devServerRepo.registered[0].ID
	if call.environmentID != registeredID {
		t.Errorf("environmentID = %q, want the resolved dev_servers.id %q", call.environmentID, registeredID)
	}
}

// TestTokenEndpoint_WithResolverAndRuntimes_NoMatchingRuntimeIsSilent covers
// the common case (a regular, non-ephemeral agent's devServerID) — a
// not-found SetEnvironmentID result must not surface as a request error or
// get logged as one; token issuance succeeds exactly as without the
// EphemeralVmRuntimes dependency wired at all.
func TestTokenEndpoint_WithResolverAndRuntimes_NoMatchingRuntimeIsSilent(t *testing.T) {
	registry := NewRegistry(time.Hour)
	t.Cleanup(registry.Stop)
	devServerRepo := &fakeResolverRepo{}
	resolver := usecase.NewResolveDirectWebSocketDevServer(devServerRepo)
	runtimes := &fakeEphemeralVmRuntimeRepo{existingRuntimeIDs: map[string]bool{}}
	issuer := NewTokenIssuer(registry, Config{APISecret: "s3cr3t", OrcaVersion: "test-version", Port: 6768, DefaultTenantID: "tenant-1"}, nil, resolver, runtimes)

	rec := doRequest(t, issuer, http.MethodPost, `{"devServerId":"dev-01"}`, "s3cr3t")

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 — a not-found SetEnvironmentID result must not fail token issuance", rec.Code)
	}
	if len(runtimes.setCalls) != 1 {
		t.Fatalf("want SetEnvironmentID still attempted once, got %d calls", len(runtimes.setCalls))
	}
}

func TestTokenEndpoint_MalformedJSONBody_Returns400(t *testing.T) {
	issuer, registry := newTestIssuer("s3cr3t")
	t.Cleanup(registry.Stop)

	rec := doRequest(t, issuer, http.MethodPost, `{not valid json`, "s3cr3t")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	body := decodeJSON(t, rec)
	if body["error"] != "bad_request" {
		t.Errorf("error = %v, want bad_request", body["error"])
	}
}

func TestTokenEndpoint_WrongMethod_Returns405(t *testing.T) {
	issuer, registry := newTestIssuer("s3cr3t")
	t.Cleanup(registry.Stop)

	rec := doRequest(t, issuer, http.MethodDelete, "", "s3cr3t")
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", rec.Code)
	}
	body := decodeJSON(t, rec)
	if body["error"] != "method_not_allowed" {
		t.Errorf("error = %v, want method_not_allowed", body["error"])
	}
}

// TestTokenEndpoint_GET_ListsPreviouslyIssuedToken covers issuing a token
// via POST, then confirming GET lists it in plaintext.
func TestTokenEndpoint_GET_ListsPreviouslyIssuedToken(t *testing.T) {
	issuer, registry := newTestIssuer("s3cr3t")
	t.Cleanup(registry.Stop)

	postRec := doRequest(t, issuer, http.MethodPost, `{"devServerId":"ds-list"}`, "s3cr3t")
	postBody := decodeJSON(t, postRec)
	issuedToken, _ := postBody["token"].(string)
	if issuedToken == "" {
		t.Fatal("POST did not return a token")
	}

	getRec := doRequest(t, issuer, http.MethodGet, "", "s3cr3t")
	if getRec.Code != http.StatusOK {
		t.Fatalf("GET status = %d, want 200", getRec.Code)
	}
	getBody := decodeJSON(t, getRec)
	tokens, _ := getBody["tokens"].([]any)
	if len(tokens) != 1 {
		t.Fatalf("tokens = %v, want exactly 1 entry", tokens)
	}
	entry, _ := tokens[0].(map[string]any)
	if entry["token"] != issuedToken {
		t.Errorf("listed token = %v, want %v (plaintext, matching the POST response)", entry["token"], issuedToken)
	}
	if entry["devServerId"] != "ds-list" {
		t.Errorf("listed devServerId = %v, want ds-list", entry["devServerId"])
	}
}

// TestTokenEndpoint_GET_OmitsConsumedToken covers a token no longer being
// listed once it's been consumed by a real handshake.
func TestTokenEndpoint_GET_OmitsConsumedToken(t *testing.T) {
	issuer, registry := newTestIssuer("s3cr3t")
	t.Cleanup(registry.Stop)

	postRec := doRequest(t, issuer, http.MethodPost, `{}`, "s3cr3t")
	postBody := decodeJSON(t, postRec)
	issuedToken, _ := postBody["token"].(string)

	if _, ok := registry.Consume(issuedToken); !ok {
		t.Fatal("Consume should have succeeded for a freshly issued token")
	}

	getRec := doRequest(t, issuer, http.MethodGet, "", "s3cr3t")
	getBody := decodeJSON(t, getRec)
	tokens, _ := getBody["tokens"].([]any)
	if len(tokens) != 0 {
		t.Errorf("tokens = %v, want empty — the token was already consumed", tokens)
	}
}
