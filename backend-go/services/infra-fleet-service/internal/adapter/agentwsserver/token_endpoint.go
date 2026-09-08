package agentwsserver

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/stablyai/orca-go/services/infra-fleet-service/internal/domain"
	"github.com/stablyai/orca-go/services/infra-fleet-service/internal/usecase"
)

const (
	// defaultTTLSeconds mirrors agent-token-routes.ts's `Number(body['ttl']
	// ?? 300)` — the default used only when the request omits ttl entirely
	// (an explicit ttl of 0 is honored as 0, not defaulted).
	defaultTTLSeconds = 300
	// ttlCapSeconds mirrors the "ephemeral: max 10 min" cap.
	ttlCapSeconds = 600
	// permanentTTL mirrors THIRTY_DAYS_SEC.
	permanentTTL = 30 * 24 * time.Hour
)

// TokenIssuer serves POST/GET /api/agent-token — the Go port of
// agent-token-routes.ts. POST mints a single-use direct-websocket agent
// token and registers it into Registry as a pending slot; GET lists
// still-pending tokens in plaintext for debugging.
//
// Registry itself only ever stores SHA-256(token) — see slots.go's doc
// comment — so GET's plaintext listing needs its own metadata, tracked here
// in meta (mirrors agent-token-routes.ts's own separate pendingMeta map).
type TokenIssuer struct {
	Registry *Registry
	Cfg      Config
	Logger   *slog.Logger
	// Resolver find-or-creates the infra.dev_servers row a minted token's
	// devServerID maps to — nil is tolerated (falls back to the pre-fix
	// behavior: token issuance still works, but the resulting session key
	// won't match any SQL row, so the Admin Console stays blind to it) for
	// unit tests that only exercise token-issuance mechanics, not
	// persistence. main.go's composition root always wires a real one.
	Resolver *usecase.ResolveDirectWebSocketDevServer
	// EphemeralVmRuntimes correlates a freshly-resolved dev_servers.id back
	// to the ephemeral_vm_runtimes row that requested it — TASK-BE-EVM-011's
	// decision (BE-SOL-EVM-003's "Quyết định đã chốt" section): the real
	// dev_servers.id PK is a UUID generated inside Resolver.Execute, only
	// known here, never inside EphemeralVmRelay.Provision's own event
	// stream. nil is tolerated the same way Resolver is — token issuance
	// still works, the runtime's environment_id just stays unset.
	EphemeralVmRuntimes usecase.EphemeralVmRuntimeRepository

	mu   sync.Mutex
	meta map[string]pendingTokenMeta // plaintext token -> metadata
}

type pendingTokenMeta struct {
	devServerID string
	expiresAt   time.Time
}

// NewTokenIssuer constructs a TokenIssuer. resolver and ephemeralVmRuntimes
// may both be nil — see TokenIssuer.Resolver's and .EphemeralVmRuntimes's
// doc comments.
func NewTokenIssuer(registry *Registry, cfg Config, logger *slog.Logger, resolver *usecase.ResolveDirectWebSocketDevServer, ephemeralVmRuntimes usecase.EphemeralVmRuntimeRepository) *TokenIssuer {
	if logger == nil {
		logger = slog.Default()
	}
	return &TokenIssuer{Registry: registry, Cfg: cfg, Logger: logger, Resolver: resolver, EphemeralVmRuntimes: ephemeralVmRuntimes, meta: make(map[string]pendingTokenMeta)}
}

// ServeHTTP handles POST and GET /api/agent-token. Auth is checked before
// any method dispatch — an unauthorized request to any method (including
// one this handler doesn't otherwise support) always gets 401, matching
// agent-token-routes.ts's isAuthorized() gate running first.
func (t *TokenIssuer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	defer func() {
		if rec := recover(); rec != nil {
			t.logger().Error("agentwsserver: token endpoint panic", slog.Any("recover", rec))
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal_error"})
		}
	}()

	if !t.isAuthorized(r) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{
			"error":   "unauthorized",
			"message": "Missing or invalid Authorization: Bearer <ORCA_AGENT_API_SECRET> header.",
		})
		return
	}

	switch r.Method {
	case http.MethodGet:
		t.handleGet(w, r)
	case http.MethodPost:
		t.handlePost(w, r)
	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method_not_allowed"})
	}
}

func (t *TokenIssuer) logger() *slog.Logger {
	if t.Logger == nil {
		return slog.Default()
	}
	return t.Logger
}

// isAuthorized mirrors agent-token-routes.ts's isAuthorized() — FIX
// TASK-AWS-001: if ORCA_AGENT_API_SECRET is not configured, this endpoint
// is BLOCKED entirely. NEVER fall back to any other auth mechanism (the TS
// reference's own historical bug, BUG-AWS-004, was exactly that — an
// insecure X-Orca-Admin header bypass — and must not be replicated here).
func (t *TokenIssuer) isAuthorized(r *http.Request) bool {
	secret := strings.TrimSpace(t.Cfg.APISecret)
	if secret == "" {
		return false
	}
	return r.Header.Get("Authorization") == "Bearer "+secret
}

// handleGet lists tokens that are still pending — i.e. issued via POST and
// not yet consumed by a real handshake, and whose own metadata TTL (not the
// Registry slot's shorter 60s connect-timeout) hasn't lapsed. Checking
// Registry.Has means a token that was already consumed, or whose slot's
// connect-timeout already fired, disappears from this listing immediately,
// even if its own longer nominal TTL (e.g. a 30-day permanent token) has
// not.
func (t *TokenIssuer) handleGet(w http.ResponseWriter, _ *http.Request) {
	type tokenEntry struct {
		Token       string `json:"token"`
		DevServerID string `json:"devServerId"`
		ExpiresIn   int    `json:"expiresIn"`
	}

	now := time.Now()
	t.mu.Lock()
	t.pruneMetaLocked(now)
	tokens := make([]tokenEntry, 0, len(t.meta))
	for token, m := range t.meta {
		if !t.Registry.Has(token) {
			continue
		}
		tokens = append(tokens, tokenEntry{
			Token:       token,
			DevServerID: m.devServerID,
			ExpiresIn:   int(m.expiresAt.Sub(now).Round(time.Second).Seconds()),
		})
	}
	t.mu.Unlock()

	writeJSON(w, http.StatusOK, map[string]any{"tokens": tokens})
}

// postTokenRequest mirrors the POST body agent-token-routes.ts reads.
// TTL is a pointer so an explicit `"ttl":0` (honored as 0) is
// distinguishable from an absent field (defaults to defaultTTLSeconds) —
// same distinction `Number(body['ttl'] ?? 300)` makes via `??`.
type postTokenRequest struct {
	DevServerID string   `json:"devServerId"`
	Name        string   `json:"name"`
	TTL         *float64 `json:"ttl"`
	Permanent   bool     `json:"permanent"`
}

// handlePost mints a token, registers it as a pending Registry slot (with
// the fixed DefaultConnectTimeout, independent of the token's own TTL
// policy computed below — see slots.go's DefaultConnectTimeout doc
// comment), and returns it plus setup instructions.
func (t *TokenIssuer) handlePost(w http.ResponseWriter, r *http.Request) {
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad_request", "message": "Invalid JSON body"})
		return
	}

	var req postTokenRequest
	if trimmed := strings.TrimSpace(string(raw)); trimmed != "" {
		if err := json.Unmarshal([]byte(trimmed), &req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad_request", "message": "Invalid JSON body"})
			return
		}
	}

	devServerID := req.DevServerID
	if devServerID == "" {
		devServerID = "dev-local"
	}
	name := req.Name
	if name == "" {
		name = fmt.Sprintf("Dev Server (%s)", devServerID)
	}

	// Resolve (find-or-create) the infra.dev_servers row this external
	// devServerID maps to. registrySlotKey — not devServerID — is what
	// Registry.Register/Consume actually track, since a later
	// AttachInboundSession(registrySlotKey, ...) session key must match
	// domain.DevServer.ID exactly (a real UUID) for ListDevServers/
	// ApproveDevServer/the Admin Console to see this connection at all. See
	// ResolveDirectWebSocketDevServer's doc comment for the full "why".
	// A resolve failure must not also break token issuance/agent
	// connectivity — it only means this connection stays invisible to the
	// Admin Console until the next successful mint, so this falls back to
	// the raw string (old behavior) rather than erroring the request.
	registrySlotKey := devServerID
	if t.Resolver != nil {
		resolved, err := t.Resolver.Execute(r.Context(), usecase.ResolveDirectWebSocketDevServerInput{
			TenantID:    t.Cfg.DefaultTenantID,
			DevServerID: devServerID,
		})
		if err != nil {
			t.logger().ErrorContext(r.Context(), "agentwsserver: resolving dev_servers row failed — agent will connect but stay invisible to the Admin Console", slog.String("devServerId", devServerID), slog.Any("error", err))
		} else {
			registrySlotKey = resolved.ID
			t.linkEphemeralVmRuntime(r.Context(), devServerID, resolved.ID)
		}
	}

	expiresIn := t.resolveExpiresIn(req)
	token := fmt.Sprintf("agt-%s-%d", devServerID, time.Now().UnixMilli())

	now := time.Now()
	t.mu.Lock()
	t.pruneMetaLocked(now)
	t.meta[token] = pendingTokenMeta{devServerID: devServerID, expiresAt: now.Add(expiresIn)}
	t.mu.Unlock()

	t.Registry.Register(token, registrySlotKey, func(string) {
		// Best-effort cleanup once the connect-timeout slot expires — not
		// strictly required for GET's correctness (Registry.Has already
		// hides it), just keeps meta from holding a stale entry forever.
		t.mu.Lock()
		delete(t.meta, token)
		t.mu.Unlock()
	})

	host := r.Host
	if host == "" {
		host = fmt.Sprintf("localhost:%d", t.Cfg.Port)
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"token":        token,
		"devServerId":  devServerID,
		"name":         name,
		"expiresIn":    int(expiresIn.Seconds()),
		"created":      true,
		"agentCommand": fmt.Sprintf("ORCA_URL=wss://%s/agent AGENT_TOKEN=%s node agent.js", host, token),
	})
}

// linkEphemeralVmRuntime writes devServerDbID (the just-resolved
// dev_servers.id PK) onto ephemeral_vm_runtimes.environment_id when
// devServerID (the agent's self-declared external id) matches a runtime's
// id for this tenant — TASK-BE-EVM-011's decision. The overwhelmingly
// common case is "no match" (most agents minting a token are not ephemeral
// VMs, and even ephemeral VM agents only match when their recipe/VM opted
// into the DEV_SERVER_ID=<runtimeID> contract) — that is not logged as an
// error, only genuine failures are, mirroring the Resolver best-effort
// pattern immediately above this call site.
func (t *TokenIssuer) linkEphemeralVmRuntime(ctx context.Context, devServerID, devServerDbID string) {
	if t.EphemeralVmRuntimes == nil {
		return
	}
	_, err := t.EphemeralVmRuntimes.SetEnvironmentID(ctx, t.Cfg.DefaultTenantID, devServerID, devServerDbID)
	if err == nil || errors.Is(err, domain.ErrEphemeralVmRuntimeNotFound) {
		return
	}
	t.logger().ErrorContext(ctx, "agentwsserver: linking ephemeral vm runtime environment_id failed", slog.String("devServerId", devServerID), slog.Any("error", err))
}

// resolveExpiresIn applies the TTL policy: a permanent token gets a 30-day
// window; an ephemeral one gets its requested ttl (defaulting to
// defaultTTLSeconds if omitted) capped at ttlCapSeconds.
func (t *TokenIssuer) resolveExpiresIn(req postTokenRequest) time.Duration {
	if req.Permanent {
		return permanentTTL
	}
	ttlSec := float64(defaultTTLSeconds)
	if req.TTL != nil {
		ttlSec = *req.TTL
	}
	if ttlSec > ttlCapSeconds {
		ttlSec = ttlCapSeconds
	}
	return time.Duration(ttlSec * float64(time.Second))
}

// pruneMetaLocked drops meta entries past their own expiry — opportunistic
// hygiene so a long-lived process doesn't accumulate stale entries forever;
// GET's correctness does not depend on this (Registry.Has is the real
// filter), this only bounds meta's size over time. Caller must hold t.mu.
func (t *TokenIssuer) pruneMetaLocked(now time.Time) {
	for token, m := range t.meta {
		if !m.expiresAt.After(now) {
			delete(t.meta, token)
		}
	}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	data, err := json.Marshal(body)
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = w.Write(data)
}
