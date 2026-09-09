// Command server is auth-service's composition root — the only place
// allowed to know about every layer at once, per
// specs/backend-go/architecture/03-clean-architecture-guidelines.md.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/grpc"
	"google.golang.org/grpc/reflection"

	"github.com/stablyai/orca-go/common/grpcmw"
	"github.com/stablyai/orca-go/common/health"
	"github.com/stablyai/orca-go/common/logging"
	"github.com/stablyai/orca-go/common/policy"
	"github.com/stablyai/orca-go/common/secrets"
	"github.com/stablyai/orca-go/common/tracing"

	svcconfig "github.com/stablyai/orca-go/services/auth-service/internal/config"

	authbcrypt "github.com/stablyai/orca-go/services/auth-service/internal/adapter/bcrypt"
	authgrpc "github.com/stablyai/orca-go/services/auth-service/internal/adapter/grpc"
	authgrpcclient "github.com/stablyai/orca-go/services/auth-service/internal/adapter/grpcclient"
	authoauth "github.com/stablyai/orca-go/services/auth-service/internal/adapter/oauth"
	authoauthstate "github.com/stablyai/orca-go/services/auth-service/internal/adapter/oauthstate"
	authopaclient "github.com/stablyai/orca-go/services/auth-service/internal/adapter/opaclient"
	authpolicypublisher "github.com/stablyai/orca-go/services/auth-service/internal/adapter/policypublisher"
	authpostgres "github.com/stablyai/orca-go/services/auth-service/internal/adapter/postgres"
	authproviderregistry "github.com/stablyai/orca-go/services/auth-service/internal/adapter/providerregistry"
	authvault "github.com/stablyai/orca-go/services/auth-service/internal/adapter/vault"
	"github.com/stablyai/orca-go/services/auth-service/internal/domain"
	"github.com/stablyai/orca-go/services/auth-service/internal/usecase"

	authv1 "github.com/stablyai/orca-go/proto/gen/go/orca/auth/v1"
)

// version is overridden at build time via -ldflags "-X main.version=...".
var version = "dev"

func main() {
	if err := run(); err != nil {
		slog.Error("auth-service exited with error", slog.Any("error", err))
		os.Exit(1)
	}
}

func run() error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	cfg, err := svcconfig.Load()
	if err != nil {
		return fmt.Errorf("loading config: %w", err)
	}

	logger := logging.New(cfg.ServiceName, version)
	slog.SetDefault(logger)

	shutdownTracing, err := tracing.Init(ctx, cfg.ServiceName, cfg.OTLPEndpoint)
	if err != nil {
		return fmt.Errorf("initializing tracing: %w", err)
	}
	defer func() { _ = shutdownTracing(context.Background()) }()

	// Prefer the Vault-Agent-rendered credentials file over the raw env var
	// (see common/secrets.DatabaseCredentialsFromFile's doc comment) —
	// falls back to DATABASE_DSN itself when the file doesn't exist, which
	// is what local dev / this scaffold's testcontainers path still uses.
	dsn, err := secrets.DatabaseCredentialsFromFile(cfg.DatabaseCredentialsFile)
	if err != nil {
		return fmt.Errorf("resolving database credentials: %w", err)
	}
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return fmt.Errorf("connecting to postgres: %w", err)
	}
	defer pool.Close()

	repo := authpostgres.New(pool)
	hasher := authbcrypt.New(cfg.BcryptCost)
	clock := usecase.SystemClock{}

	// Real Vault wiring, mirroring credential-broker-service's cmd/server/
	// main.go pattern — secrets.NewClient() reads VAULT_ADDR/VAULT_TOKEN
	// from the environment (local-dev static token; production
	// authenticates via the Kubernetes auth method through a Vault Agent
	// sidecar instead — see common/secrets.NewClient's doc comment and this
	// service's README "Known gaps").
	vaultClient, err := secrets.NewClient()
	if err != nil {
		return fmt.Errorf("creating vault client: %w", err)
	}
	tokenSigner := authvault.New(vaultClient)
	// Fail startup loudly if the jwt-signing Transit key can't be
	// ensured — every JWT this service issues depends on it existing.
	if err := tokenSigner.Ensure(ctx); err != nil {
		return fmt.Errorf("ensuring jwt-signing transit key: %w", err)
	}

	// opaEvaluator loads/compiles the orca-authz bundle once per distinct
	// query string (common/policy.Evaluator's own cache) and is shared by
	// every requireAdminActor call for this process's lifetime.
	opaEvaluator := policy.NewEvaluator(cfg.OPABundlePath)
	if err := opaEvaluator.Warm(ctx, "data.orca.authz.admin.allow"); err != nil {
		return fmt.Errorf("auth-service: OPA bundle failed to load at startup (bundle path %q): %w", cfg.OPABundlePath, err)
	}
	opaClient := authopaclient.New(opaEvaluator)

	loginUC := usecase.NewLogin(repo, repo, repo, hasher, clock, cfg.SessionTTL)
	logoutUC := usecase.NewLogout(repo, repo, clock)
	validateSessionUC := usecase.NewValidateSession(repo, repo, clock)
	createUserUC := usecase.NewCreateUser(repo, repo, hasher, clock, opaClient)
	listUsersUC := usecase.NewListUsers(repo, opaClient)
	updateUserRoleUC := usecase.NewUpdateUserRole(repo, repo, clock, opaClient)
	revokeSessionUC := usecase.NewRevokeSession(repo, repo, repo, clock, opaClient)
	queryAuditLogUC := usecase.NewQueryAuditLog(repo, repo, opaClient)
	appendAuditEntryUC := usecase.NewAppendAuditEntry(repo, clock)
	issueServiceTokenUC := usecase.NewIssueServiceToken(repo, repo, repo, tokenSigner, clock, cfg.ServiceTokenTTL)
	getJWKSUC := usecase.NewGetJWKS(tokenSigner)
	isServiceTokenRevokedUC := usecase.NewIsServiceTokenRevoked(repo)
	listCliTokensUC := usecase.NewListCliTokens(repo)
	revokeCliTokenUC := usecase.NewRevokeCliToken(repo, repo, repo, clock)

	deactivateUserUC := usecase.NewDeactivateUser(repo, repo, clock, opaClient)
	reactivateUserUC := usecase.NewReactivateUser(repo, repo, clock, opaClient)
	listSessionsForUserUC := usecase.NewListSessionsForUser(repo, repo, opaClient)
	forceRevokeAllSessionsForUserUC := usecase.NewForceRevokeAllSessionsForUser(repo, repo, repo, clock, opaClient)
	forceRevokeSessionUC := usecase.NewForceRevokeSession(repo, repo, repo, clock, opaClient)

	// policyPublisher writes a changed AccessPolicy's document_json into the
	// shared OPA bundle path (TASK-BE-027/CR-RBAC-006) so
	// create/update/delete take effect without a process restart, paired
	// with opaEvaluator's own self-invalidation (TASK-BE-024). Set
	// OPA_POLICY_PUBLISH_DISABLED=true to fall back to the old logging-only
	// NoopPublisher stub as a rollback lever, mirroring
	// common/policy.Evaluator's checkPeriod:0 rollback path — see
	// config.Config.DisablePolicyPublish's doc comment.
	var policyPublisher usecase.PolicyDataPublisher
	if cfg.DisablePolicyPublish {
		logger.WarnContext(ctx, "auth-service: OPA_POLICY_PUBLISH_DISABLED=true — policy changes will be persisted but NOT published to the OPA bundle")
		policyPublisher = authpolicypublisher.New(logger)
	} else {
		policyPublisher = authpolicypublisher.NewFilePublisher(cfg.OPABundlePath, opaEvaluator)
	}
	createAccessPolicyUC := usecase.NewCreateAccessPolicy(repo, repo, policyPublisher, clock, opaClient)
	getAccessPolicyUC := usecase.NewGetAccessPolicy(repo, repo, opaClient)
	listAccessPoliciesUC := usecase.NewListAccessPolicies(repo, repo, opaClient)
	updateAccessPolicyUC := usecase.NewUpdateAccessPolicy(repo, repo, policyPublisher, clock, opaClient)
	deleteAccessPolicyUC := usecase.NewDeleteAccessPolicy(repo, repo, policyPublisher, clock, opaClient)
	getAdminStatsUC := usecase.NewGetAdminStats(repo, repo, repo, clock, opaClient)
	listTenantMemberDirectoryUC := usecase.NewListTenantMemberDirectory(repo)

	// Runs once, before the server starts accepting traffic — see
	// internal/usecase/bootstrap.go's doc comment for why this isn't an
	// RPC. No-op unless BOOTSTRAP_ADMIN_EMAIL is set AND no user already
	// exists anywhere. Only dial tenant-service when bootstrap will
	// actually run — avoids adding an always-on startup dependency on
	// tenant-service being reachable for every ordinary (already
	// bootstrapped) boot.
	if cfg.BootstrapAdminEmail != "" {
		tenantProvisioner, err := authgrpcclient.NewTenantProvisioner(cfg.TenantServiceAddr)
		if err != nil {
			return fmt.Errorf("dialing tenant-service: %w", err)
		}
		defer func() { _ = tenantProvisioner.Close() }()

		bootstrap := usecase.NewBootstrap(repo, repo, hasher, clock, tenantProvisioner)
		generatedPassword, err := bootstrap.EnsureAdmin(ctx, usecase.BootstrapConfig{
			CompanyName: cfg.BootstrapCompanyName,
			Email:       cfg.BootstrapAdminEmail,
			Password:    cfg.BootstrapAdminPassword,
		}, logger)
		if err != nil {
			return fmt.Errorf("bootstrapping admin user: %w", err)
		}
		if generatedPassword != "" {
			// Printed once, at first boot, never stored — same contract the
			// old TS backend used for an auto-generated admin password.
			logger.Warn("auth-service: AUTO-GENERATED ADMIN PASSWORD (save this now, it will not be shown again)",
				slog.String("email", cfg.BootstrapAdminEmail),
				slog.String("password", generatedPassword))
		}
	}

	// --- CR-LOGIN-001 (SSO: GitHub / Google / generic OIDC) ---
	// Each provider is registered only when its SSO_*_CLIENT_ID is set —
	// an unconfigured provider is simply absent from the registry map, and
	// StartSsoLogin surfaces AUTH_SSO_PROVIDER_UNSUPPORTED for it, the same
	// "absent, not zero-valued" convention scm-integration-service's own
	// OAuth registry uses.
	ssoExchangers := map[domain.SsoProvider]usecase.SsoExchanger{}
	if cfg.Sso.GitHub.ClientID != "" {
		ssoExchangers[domain.SsoProviderGitHub] = authoauth.NewGitHub(nil, authoauth.GitHubConfig{
			ClientID: cfg.Sso.GitHub.ClientID, ClientSecret: cfg.Sso.GitHub.ClientSecret,
		})
	}
	if cfg.Sso.Google.ClientID != "" {
		// Google's OIDC endpoints are fixed, well-known constants — its
		// CR-LOGIN-001 env var list has no DISCOVERY_URL, unlike generic OIDC.
		ssoExchangers[domain.SsoProviderGoogle] = authoauth.NewOidc(nil, domain.SsoProviderGoogle, authoauth.OidcConfig{
			AuthorizeURL: "https://accounts.google.com/o/oauth2/v2/auth",
			TokenURL:     "https://oauth2.googleapis.com/token",
			UserInfoURL:  "https://openidconnect.googleapis.com/v1/userinfo",
			ClientID:     cfg.Sso.Google.ClientID, ClientSecret: cfg.Sso.Google.ClientSecret,
		})
	}
	if cfg.Sso.OIDC.ClientID != "" && cfg.Sso.OidcDiscoveryURL != "" {
		// Resolved once at startup, not per-request — see
		// FetchDiscoveryDocument's doc comment. Fails startup loudly on an
		// unreachable/malformed discovery document, same "fail fast, not
		// silently degraded" posture as the Vault Transit key check above.
		discoveryCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		authorizeURL, tokenURL, userInfoURL, err := authoauth.FetchDiscoveryDocument(discoveryCtx, nil, cfg.Sso.OidcDiscoveryURL)
		cancel()
		if err != nil {
			return fmt.Errorf("fetching oidc discovery document from %q: %w", cfg.Sso.OidcDiscoveryURL, err)
		}
		ssoExchangers[domain.SsoProviderOIDC] = authoauth.NewOidc(nil, domain.SsoProviderOIDC, authoauth.OidcConfig{
			AuthorizeURL: authorizeURL, TokenURL: tokenURL, UserInfoURL: userInfoURL,
			ClientID: cfg.Sso.OIDC.ClientID, ClientSecret: cfg.Sso.OIDC.ClientSecret,
		})
	}
	ssoRegistry := authproviderregistry.NewSsoRegistry(ssoExchangers)
	ssoStates := authoauthstate.New(cfg.SsoStateSecret)

	// tenantResolver is only dialed when at least one SSO provider is
	// registered — same "avoid an always-on startup dependency for a
	// feature that isn't configured" rule Bootstrap's TenantProvisioner
	// dial follows above.
	var tenantResolver *authgrpcclient.TenantResolver
	if len(ssoExchangers) > 0 {
		tenantResolver, err = authgrpcclient.NewTenantResolver(cfg.TenantServiceAddr)
		if err != nil {
			return fmt.Errorf("dialing tenant-service for sso provisioning: %w", err)
		}
		defer func() { _ = tenantResolver.Close() }()
	}

	startSsoLoginUC := usecase.NewStartSsoLogin(ssoRegistry, ssoStates, nil)
	// tenantResolver may be a nil-but-typed *TenantResolver here (when no
	// provider is configured) — safe, because LoginOrProvisionSsoUser only
	// ever reaches uc.tenants.ResolveDefaultTenant via CompleteSsoLogin,
	// which itself only runs after SsoExchangerRegistry.Resolve succeeds
	// for a request's provider, which requires len(ssoExchangers) > 0,
	// which is exactly the condition tenantResolver was dialed under above.
	loginOrProvisionSsoUserUC := usecase.NewLoginOrProvisionSsoUser(repo, repo, repo, repo, hasher, tenantResolver, repo, clock, cfg.SessionTTL)
	completeSsoLoginUC := usecase.NewCompleteSsoLogin(ssoRegistry, ssoStates, loginOrProvisionSsoUserUC)

	// --- CR-RBAC-003 (SSO group->role mapping, session refresh) ---
	refreshSessionUC := usecase.NewRefreshSession(repo, clock, cfg.SessionTTL, usecase.DefaultRefreshTokenTTL)
	updateSsoGroupMappingUC := usecase.NewUpdateSsoGroupMapping(repo, repo, clock, opaClient)
	listSsoGroupMappingUC := usecase.NewListSsoGroupMapping(repo, repo, opaClient)

	grpcServer := grpc.NewServer(grpcmw.ChainUnary(logger), grpcmw.StatsHandler())
	authv1.RegisterAuthServiceServer(grpcServer, authgrpc.New(
		loginUC, logoutUC, validateSessionUC,
		createUserUC, listUsersUC, updateUserRoleUC, revokeSessionUC, queryAuditLogUC,
		appendAuditEntryUC,
		issueServiceTokenUC, getJWKSUC,
		isServiceTokenRevokedUC, listCliTokensUC, revokeCliTokenUC,
		deactivateUserUC, reactivateUserUC, listSessionsForUserUC, forceRevokeAllSessionsForUserUC,
		forceRevokeSessionUC,
		createAccessPolicyUC, getAccessPolicyUC, listAccessPoliciesUC, updateAccessPolicyUC, deleteAccessPolicyUC,
		getAdminStatsUC,
		listTenantMemberDirectoryUC,
		startSsoLoginUC, completeSsoLoginUC,
		refreshSessionUC, updateSsoGroupMappingUC, listSsoGroupMappingUC,
	))
	reflection.Register(grpcServer) // convenient for grpcurl during local dev; keep enabled behind the mesh, not the public internet

	healthSrv := health.New()
	healthSrv.Register("postgres", func() error {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		return pool.Ping(ctx)
	})
	// Vault reachability gates readiness — IssueServiceToken/GetJWKS can
	// only serve real signatures/JWKS while Vault is reachable, so a pod
	// that can't reach it should be pulled out of rotation. See
	// internal/adapter/vault.TokenSigner.Ping's doc comment.
	healthSrv.Register("vault", func() error {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		return tokenSigner.Ping(ctx)
	})

	httpServer := &http.Server{
		Addr:    fmt.Sprintf(":%d", cfg.HTTPPort),
		Handler: healthSrv.Handler(),
	}

	errCh := make(chan error, 2)

	go func() {
		lis, err := net.Listen("tcp", fmt.Sprintf(":%d", cfg.GRPCPort))
		if err != nil {
			errCh <- fmt.Errorf("listening on grpc port: %w", err)
			return
		}
		logger.Info("auth-service grpc listening", slog.Int("port", cfg.GRPCPort))
		if err := grpcServer.Serve(lis); err != nil {
			errCh <- fmt.Errorf("grpc server: %w", err)
		}
	}()

	go func() {
		logger.Info("auth-service http (health) listening", slog.Int("port", cfg.HTTPPort))
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- fmt.Errorf("http server: %w", err)
		}
	}()

	select {
	case <-ctx.Done():
		logger.Info("shutdown signal received, draining in-flight requests")
	case err := <-errCh:
		return err
	}

	// Graceful shutdown: GracefulStop drains in-flight gRPC calls before
	// returning, matching the termination-grace-period expectation in
	// standards/production-readiness-checklist.md.
	grpcServer.GracefulStop()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = httpServer.Shutdown(shutdownCtx)

	return nil
}
