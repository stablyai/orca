package httpgateway

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	authv1 "github.com/stablyai/orca-go/proto/gen/go/orca/auth/v1"
)

const sessionCookieName = "orca_session"

// refreshCookieName holds the raw refresh token every session is now
// issued at creation (TASK-BE-012/login.go's createSessionForUser) — kept
// in its own cookie, scoped to /auth only (see setRefreshCookie), so it is
// never sent on ordinary app requests the way orca_session is.
const refreshCookieName = "orca_refresh"

// refreshCookieTTL mirrors auth-service's usecase.DefaultRefreshTokenTTL
// (refresh_session.go) — duplicated because api-gateway does not import
// auth-service's internal packages; keep the two in sync if either changes.
const refreshCookieTTL = 30 * 24 * time.Hour

// authUserResponse mirrors frontend/src/renderer/src/auth/auth-types.ts's
// AuthUser EXACTLY — GET /auth/me and POST /auth/local both return this
// shape directly (not nested under a "user" key — an earlier version of
// this file did nest it, which silently broke loginLocal()'s `return body
// as AuthUser`; found live 2026-08-17, see docs/execution-plan.md §0).
type authUserResponse struct {
	ID    string `json:"id"`
	Email string `json:"email"`
	Name  string `json:"name"`
	// Role: frontend's type is 'developer'|'lead'|'admin' — auth-service's
	// domain.Role only has User|Admin (no "lead" concept yet), so Admin
	// maps to "admin" and everything else maps to "developer". Revisit if
	// backend-go ever grows a 3-tier role model.
	Role string `json:"role"`
	// Provider: "none" for a local-password account, otherwise the SSO
	// provider ("github" | "google" | "keycloak") the user last
	// authenticated through — see toFrontendProviderLabel's doc comment
	// for the "oidc" -> "keycloak" translation.
	Provider string `json:"provider"`
}

func toAuthUserResponse(u *authv1.User) authUserResponse {
	role := "developer"
	if u.GetRole() == authv1.Role_ROLE_ADMIN {
		role = "admin"
	}
	return authUserResponse{
		ID: u.GetId(), Email: u.GetEmail(), Name: u.GetName(),
		Role: role, Provider: toFrontendProviderLabel(u.GetProvider()),
	}
}

// toFrontendProviderLabel translates auth-service's provider string
// ("none"|"github"|"google"|"oidc") to what frontend/'s SsoProvider type
// expects: everything is 1:1 except "oidc", which the frontend labels
// "keycloak" (see SsoButton.tsx / auth-types.ts) — the wire concept is
// generic OIDC, the UI label is the concrete IdP this deployment actually
// points it at. See ssoConfigProviderKey for the inverse mapping used by
// GET /auth/config and GET /auth/sso/{provider}.
func toFrontendProviderLabel(backendProvider string) string {
	if backendProvider == "oidc" {
		return "keycloak"
	}
	return backendProvider
}

type loginRequestBody struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

// SsoRouteConfig is the slice of api-gateway's config mountAuthRoutes needs
// for the real SSO routes — passed explicitly rather than the whole
// svcconfig.Config so this file (like the rest of httpgateway/) never
// imports internal/config directly.
type SsoRouteConfig struct {
	// PublicBaseURL builds the redirect_uri sent to auth-service — see
	// handleSsoStart's doc comment for why this is never derived from the
	// request's Host header.
	PublicBaseURL string
	// AuthMode is "local" | "sso" | "both" (default) — see handleAuthConfig's
	// doc comment.
	AuthMode string
	// GithubClientID/GoogleClientID/OidcClientID gate which providers
	// GET /auth/config reports as available — an empty value means "not
	// configured", the provider is simply omitted. Only the client ID
	// (never secret) is duplicated here from auth-service's own config;
	// client ids are public per the OAuth2 spec (they appear in every
	// authorization URL), so this avoids GET /auth/config needing a
	// round-trip gRPC call to auth-service on every unauthenticated page
	// load.
	GithubClientID string
	GoogleClientID string
	OidcClientID   string
}

// mountAuthRoutes wires the plain-HTTP (non-WS, non-/v1) routes this
// gateway serves directly under /auth/* — matching
// specs/frontend/api/http-endpoints.md's documented contract exactly
// (paths, response shapes) so frontend/'s auth-api-client.ts works
// unmodified. None of these run behind authMiddleware (see router.go) —
// /auth/me and /auth/logout each validate their own cookie inline instead.
func mountAuthRoutes(mux chi.Router, authClient authv1.AuthServiceClient, cookieValidator CookieSessionValidator, ssoCfg SsoRouteConfig) {
	mux.Post("/auth/local", func(w http.ResponseWriter, r *http.Request) {
		var body loginRequestBody
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSONError(w, http.StatusBadRequest, "INVALID_BODY", "invalid request body")
			return
		}

		resp, err := authClient.Login(r.Context(), &authv1.LoginRequest{
			Email:    body.Email,
			Password: body.Password,
		})
		if err != nil {
			// Deliberately generic — do not leak "user not found" vs "wrong
			// password" distinctions to the client, matching standard
			// login-endpoint practice.
			writeJSONError(w, http.StatusUnauthorized, "INVALID_CREDENTIALS", "invalid email or password")
			return
		}

		setSessionCookie(w, resp.GetSessionToken())
		setRefreshCookie(w, resp.GetRefreshToken())
		writeJSON(w, http.StatusOK, toAuthUserResponse(resp.GetUser()))
	})

	mux.Get("/auth/me", func(w http.ResponseWriter, r *http.Request) {
		id, err := cookieValidator.ValidateCookie(r.Context(), r)
		if err != nil {
			// fetchCurrentUser() specifically branches on status===401 to
			// mean "not logged in" (returns null, not an error) — every
			// other non-2xx is treated as a hard failure. Must be a real 401.
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		// ValidateCookie only resolves tenant/user IDs (wscompat.Identity),
		// not the full profile — one more round trip to get
		// email/name/role for the response body.
		resp, err := authClient.ValidateSession(r.Context(), &authv1.ValidateSessionRequest{SessionToken: cookieValue(r)})
		if err != nil || !resp.GetValid() {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_ = id // identity already reflected in resp.GetUser(); kept for symmetry with other handlers
		writeJSON(w, http.StatusOK, toAuthUserResponse(resp.GetUser()))
	})

	mux.Post("/auth/logout", func(w http.ResponseWriter, r *http.Request) {
		if token := cookieValue(r); token != "" {
			_, _ = authClient.Logout(r.Context(), &authv1.LogoutRequest{SessionToken: token})
		}
		http.SetCookie(w, &http.Cookie{
			Name: sessionCookieName, Value: "", Path: "/", MaxAge: -1,
			HttpOnly: true, Secure: true, SameSite: http.SameSiteStrictMode,
		})
		// TASK-BE-012: a session logged out this way also had a refresh
		// token — clear it too, or /auth/refresh could silently resurrect a
		// session the user just explicitly logged out of.
		clearRefreshCookie(w)
		w.WriteHeader(http.StatusOK)
	})

	// POST /auth/refresh — frontend/'s auth-api-client.ts's refreshSession()
	// calls this with no body (credentials:'include' only), expecting the
	// same authUserResponse shape /auth/me returns on success, or a plain
	// 401 it treats as "not logged in" (never throws for that case). Reads
	// orca_refresh (not orca_session — that cookie is likely expired/near-
	// expiry, which is exactly why the caller is refreshing), rotates it via
	// RefreshSession, and re-sets BOTH cookies with the new pair — a refresh
	// token is single-use (TASK-BE-011's reuse-detection revokes the whole
	// session on a replay), so the old orca_refresh value must never be
	// presented again after this succeeds.
	mux.Post("/auth/refresh", func(w http.ResponseWriter, r *http.Request) {
		refreshToken := refreshCookieValue(r)
		if refreshToken == "" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		resp, err := authClient.RefreshSession(r.Context(), &authv1.RefreshSessionRequest{RefreshToken: refreshToken})
		if err != nil {
			// Any failure (unknown/expired/revoked/reused token) means this
			// refresh token is now dead either way — clear both cookies so
			// the client's next /auth/me cleanly reports "logged out"
			// rather than retrying a refresh that will never succeed.
			http.SetCookie(w, &http.Cookie{
				Name: sessionCookieName, Value: "", Path: "/", MaxAge: -1,
				HttpOnly: true, Secure: true, SameSite: http.SameSiteStrictMode,
			})
			clearRefreshCookie(w)
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		setSessionCookie(w, resp.GetSessionToken())
		setRefreshCookie(w, resp.GetRefreshToken())
		// RefreshSessionResponse carries no User (unlike Login/CompleteSsoLogin)
		// — one more round trip, same as GET /auth/me's own pattern below.
		userResp, err := authClient.ValidateSession(r.Context(), &authv1.ValidateSessionRequest{SessionToken: resp.GetSessionToken()})
		if err != nil || !userResp.GetValid() {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		writeJSON(w, http.StatusOK, toAuthUserResponse(userResp.GetUser()))
	})

	// GET /auth/config reports which providers are actually usable: a
	// provider only appears when its SSO_*_CLIENT_ID is set AND AuthMode
	// allows SSO ("both", the default, or "sso"). localEnabled is false
	// only under AuthMode=sso — /auth/local itself stays mounted either
	// way (this route never disables it), matching AuthMode's semantics as
	// "what the login page offers", not "what the server accepts".
	mux.Get("/auth/config", func(w http.ResponseWriter, r *http.Request) {
		providers := []string{}
		if ssoCfg.AuthMode != "local" {
			if ssoCfg.GithubClientID != "" {
				providers = append(providers, "github")
			}
			if ssoCfg.GoogleClientID != "" {
				providers = append(providers, "google")
			}
			if ssoCfg.OidcClientID != "" {
				providers = append(providers, "keycloak")
			}
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"providers":    providers,
			"localEnabled": ssoCfg.AuthMode != "sso",
		})
	})

	mux.Get("/auth/sso/{provider}", handleSsoStart(authClient, ssoCfg))
	mux.Get("/auth/callback", handleSsoCallback(authClient))
}

// ssoConfigProviderKey translates the frontend/URL-facing provider name
// ("keycloak") to the wire value auth-service's provider registry is keyed
// by ("oidc") — the inverse of toFrontendProviderLabel. "github"/"google"
// pass through unchanged.
func ssoConfigProviderKey(urlProvider string) string {
	if urlProvider == "keycloak" {
		return "oidc"
	}
	return urlProvider
}

// handleSsoStart builds api-gateway's own redirect_uri from PublicBaseURL
// (NEVER from r.Host/X-Forwarded-Host) and asks auth-service for the
// provider's authorization URL, then 302s the browser there.
//
// Why never derive redirect_uri from the request's Host header: an
// attacker-controlled Host header would let them redirect the OAuth code
// exchange to an attacker-chosen callback URL, IF that URL happened to
// match what's registered with the IdP for this client_id — a known
// real-world vulnerability class (Host-header injection into an OAuth
// redirect_uri). PublicBaseURL is operator-configured, out of request
// control, and must match byte-for-byte what's registered as this
// deployment's authorized redirect URI with each configured IdP.
func handleSsoStart(authClient authv1.AuthServiceClient, ssoCfg SsoRouteConfig) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		provider := ssoConfigProviderKey(chi.URLParam(r, "provider"))
		if ssoCfg.PublicBaseURL == "" {
			writeJSONError(w, http.StatusNotImplemented, "AUTH_SSO_NOT_CONFIGURED", "sso is not configured for this deployment")
			return
		}

		resp, err := authClient.StartSsoLogin(r.Context(), &authv1.StartSsoLoginRequest{
			Provider:    provider,
			RedirectUri: ssoCfg.PublicBaseURL + "/auth/callback",
		})
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, "AUTH_SSO_START_FAILED", "sso provider is not supported or not configured")
			return
		}
		http.Redirect(w, r, resp.GetAuthorizationUrl(), http.StatusFound)
	}
}

// handleSsoCallback completes the flow: auth-service verifies the state
// token + exchanges the code, and this handler just sets the exact same
// orca_session cookie POST /auth/local sets (setSessionCookie), then
// redirects to "/" — the browser's next load re-runs fetchCurrentUser()/
// fetchAuthConfig() (main-web-bootstrap.tsx's WebRootBoundary) and picks up
// the now-valid cookie, same as a page refresh after local login would.
// No client-side SSO completion handler is needed.
func handleSsoCallback(authClient authv1.AuthServiceClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		resp, err := authClient.CompleteSsoLogin(r.Context(), &authv1.CompleteSsoLoginRequest{
			Code:  r.URL.Query().Get("code"),
			State: r.URL.Query().Get("state"),
		})
		if err != nil {
			// Redirect (not a bare API error page) so LoginPage can surface
			// a message — mirrors how a failed local login stays on the
			// login page instead of showing a raw JSON error.
			http.Redirect(w, r, "/?ssoError=1", http.StatusFound)
			return
		}
		setSessionCookie(w, resp.GetSessionToken())
		setRefreshCookie(w, resp.GetRefreshToken())
		http.Redirect(w, r, "/", http.StatusFound)
	}
}

func setSessionCookie(w http.ResponseWriter, token string) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		Secure:   true, // always on, per api-gateway.md §9 — no NODE_ENV-gated exception, unlike the old TS backend's documented bug
		SameSite: http.SameSiteStrictMode,
		MaxAge:   int(24 * time.Hour / time.Second),
	})
}

// setRefreshCookie stores the raw refresh token TASK-BE-012 added to every
// Login/CompleteSsoLogin/RefreshSession response. Path is deliberately
// "/auth" (not "/", unlike orca_session) — the refresh token is only ever
// needed by /auth/refresh and /auth/logout (to clear it), so scoping it
// narrower keeps it off every other request's Cookie header.
func setRefreshCookie(w http.ResponseWriter, token string) {
	http.SetCookie(w, &http.Cookie{
		Name:     refreshCookieName,
		Value:    token,
		Path:     "/auth",
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteStrictMode,
		MaxAge:   int(refreshCookieTTL / time.Second),
	})
}

// clearRefreshCookie expires an orca_refresh cookie — same Path as
// setRefreshCookie (a cookie clear must match Path or the browser treats it
// as a different cookie and leaves the original in place).
func clearRefreshCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name: refreshCookieName, Value: "", Path: "/auth", MaxAge: -1,
		HttpOnly: true, Secure: true, SameSite: http.SameSiteStrictMode,
	})
}

func cookieValue(r *http.Request) string {
	c, err := r.Cookie(sessionCookieName)
	if err != nil {
		return ""
	}
	return c.Value
}

func refreshCookieValue(r *http.Request) string {
	c, err := r.Cookie(refreshCookieName)
	if err != nil {
		return ""
	}
	return c.Value
}
