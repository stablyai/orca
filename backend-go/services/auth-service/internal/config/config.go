// Package config loads auth-service's runtime configuration — env/flag
// parsing only, no business logic, per architecture/03-clean-architecture-guidelines.md.
package config

import (
	"fmt"
	"os"
	"strconv"
	"time"

	commonconfig "github.com/stablyai/orca-go/common/config"
)

type Config struct {
	commonconfig.Base
	// BcryptCost is the bcrypt work factor CreateUser hashes new
	// passwords with. Floored at adapter/bcrypt.MinCost (12) regardless of
	// what's configured — see auth-service.md §9.
	BcryptCost int
	// SessionTTL is how long a session created by Login stays valid.
	SessionTTL time.Duration

	// ServiceTokenTTL is how long a JWT minted by IssueServiceToken stays
	// valid before "exp" — see internal/usecase/issue_service_token.go.
	ServiceTokenTTL time.Duration

	// OPABundlePath points requireAdminActor's OPA client
	// (internal/adapter/opaclient, via common/policy.Evaluator) at the
	// orca-authz Rego bundle on disk. Defaults to the bundle's location
	// relative to this service's module root when run the way this
	// service's README's "Running locally" section runs it (`cd
	// services/auth-service && go run ./cmd/server`); override for
	// container images that lay the bundle out elsewhere. Same env var
	// name as task-service/annotation-service's own OPABundlePath, for
	// consistency across Epic E's consuming services.
	OPABundlePath string

	// DisablePolicyPublish forces cmd/server/main.go to wire NoopPublisher
	// instead of FilePublisher for PolicyDataPublisher (TASK-BE-027) — a
	// rollback lever for a deployment where a real bundle write turns out
	// unsafe, consistent with common/policy.Evaluator's own
	// checkPeriod:0 rollback path (TASK-BE-024). Off (false) by default:
	// policy changes publish for real.
	DisablePolicyPublish bool

	// Bootstrap* configure the one-time first-admin creation
	// (internal/usecase/bootstrap.go) — no-op unless BootstrapAdminEmail is
	// set. BootstrapAdminPassword empty => auto-generate and log once at
	// startup, mirroring the old TS backend's
	// ORCA_ADMIN_EMAIL/ORCA_ADMIN_PASSWORD behavior. BootstrapCompanyName
	// is optional (empty => bootstrap.go derives one from the admin
	// email's domain) — there is no BootstrapTenantID: tenant-service
	// originates the tenant id itself (see bootstrap.go's doc comment,
	// specs/backend-go/bugs/missing-v2/BUG-002/SOL-002).
	BootstrapCompanyName   string
	BootstrapAdminEmail    string
	BootstrapAdminPassword string

	// TenantServiceAddr is where bootstrap.go's TenantProvisioner dials to
	// originate a tenant for the first admin — only used when
	// BootstrapAdminEmail is set (see cmd/server/main.go).
	TenantServiceAddr string

	// DatabaseCredentialsFile is the path a Vault Agent sidecar renders
	// dynamic Postgres credentials to in production (see
	// common/secrets.DatabaseCredentialsFromFile). Falls back to DATABASE_DSN
	// (via Base) when the file doesn't exist, which is what local dev and
	// this scaffold's testcontainers path use instead.
	DatabaseCredentialsFile string

	// SsoStateSecret HMAC-signs the SSO flow's state token (see
	// internal/adapter/oauthstate.Codec) — mirrors
	// scm-integration-service's OAuthStateSecret. Empty is accepted at
	// load time (so this scaffold still boots with SSO simply
	// unconfigured) but produces forgeable tokens; never run with one in
	// any real deployment.
	SsoStateSecret string
	// Sso holds each provider's OAuth2/OIDC client credentials + generic-
	// OIDC endpoints — see cmd/server/main.go's composition root for how
	// an empty ClientID means "this provider is not registered" (absent
	// from the SsoExchangerRegistry map entirely, not a zero-value client).
	Sso SsoProvidersConfig
}

// SsoProviderConfig is one provider's OAuth2 client credentials.
type SsoProviderConfig struct {
	ClientID     string
	ClientSecret string
}

// SsoProvidersConfig configures CR-LOGIN-001's three supported providers.
// Google's endpoints are fixed constants at the call site (main.go) — its
// env var list (per CR-LOGIN-001) has no DISCOVERY_URL, unlike generic
// OIDC/Keycloak, whose endpoints are resolved once at startup from
// OidcDiscoveryURL.
type SsoProvidersConfig struct {
	GitHub SsoProviderConfig // SSO_GITHUB_CLIENT_ID / SSO_GITHUB_CLIENT_SECRET
	Google SsoProviderConfig // SSO_GOOGLE_CLIENT_ID / SSO_GOOGLE_CLIENT_SECRET
	OIDC   SsoProviderConfig // SSO_OIDC_CLIENT_ID / SSO_OIDC_CLIENT_SECRET
	// OidcDiscoveryURL points at a generic/self-hosted OIDC provider's
	// /.well-known/openid-configuration (e.g. Keycloak realm's discovery
	// document). Empty means generic OIDC is not registered, independent
	// of whether OIDC.ClientID is set.
	OidcDiscoveryURL string
}

func Load() (Config, error) {
	base, err := commonconfig.LoadBase("auth-service")
	if err != nil {
		return Config{}, err
	}

	bcryptCost, err := intEnv("BCRYPT_COST", 12)
	if err != nil {
		return Config{}, err
	}

	sessionTTL, err := durationEnv("SESSION_TTL", 24*time.Hour)
	if err != nil {
		return Config{}, err
	}

	serviceTokenTTL, err := durationEnv("SERVICE_TOKEN_TTL", 15*time.Minute)
	if err != nil {
		return Config{}, err
	}

	return Config{
		Base:                    base,
		BcryptCost:              bcryptCost,
		SessionTTL:              sessionTTL,
		ServiceTokenTTL:         serviceTokenTTL,
		OPABundlePath:           commonconfig.StringEnv("OPA_BUNDLE_PATH", "/policy/orca-authz"),
		DisablePolicyPublish:    boolEnv("OPA_POLICY_PUBLISH_DISABLED", false),
		BootstrapCompanyName:    os.Getenv("BOOTSTRAP_COMPANY_NAME"),
		BootstrapAdminEmail:     os.Getenv("BOOTSTRAP_ADMIN_EMAIL"),
		BootstrapAdminPassword:  os.Getenv("BOOTSTRAP_ADMIN_PASSWORD"),
		TenantServiceAddr:       commonconfig.StringEnv("TENANT_SERVICE_ADDR", "tenant-service:9090"),
		DatabaseCredentialsFile: commonconfig.StringEnv("DATABASE_CREDENTIALS_FILE", "/vault/secrets/database-credentials"),
		SsoStateSecret:          commonconfig.StringEnv("SSO_STATE_SECRET", ""),
		Sso: SsoProvidersConfig{
			GitHub: SsoProviderConfig{
				ClientID:     commonconfig.StringEnv("SSO_GITHUB_CLIENT_ID", ""),
				ClientSecret: commonconfig.StringEnv("SSO_GITHUB_CLIENT_SECRET", ""),
			},
			Google: SsoProviderConfig{
				ClientID:     commonconfig.StringEnv("SSO_GOOGLE_CLIENT_ID", ""),
				ClientSecret: commonconfig.StringEnv("SSO_GOOGLE_CLIENT_SECRET", ""),
			},
			OIDC: SsoProviderConfig{
				ClientID:     commonconfig.StringEnv("SSO_OIDC_CLIENT_ID", ""),
				ClientSecret: commonconfig.StringEnv("SSO_OIDC_CLIENT_SECRET", ""),
			},
			OidcDiscoveryURL: commonconfig.StringEnv("SSO_OIDC_DISCOVERY_URL", ""),
		},
	}, nil
}

func intEnv(key string, def int) (int, error) {
	v := os.Getenv(key)
	if v == "" {
		return def, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return 0, fmt.Errorf("config: invalid int for %s=%q: %w", key, v, err)
	}
	return n, nil
}

func boolEnv(key string, def bool) bool {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		return def
	}
	return b
}

func durationEnv(key string, def time.Duration) (time.Duration, error) {
	v := os.Getenv(key)
	if v == "" {
		return def, nil
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		return 0, fmt.Errorf("config: invalid duration for %s=%q: %w", key, v, err)
	}
	return d, nil
}
