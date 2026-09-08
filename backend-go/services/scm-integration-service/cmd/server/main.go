// Command server is scm-integration-service's composition root — the only
// place allowed to know about every layer at once, per
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
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/reflection"

	"github.com/stablyai/orca-go/common/grpcmw"
	"github.com/stablyai/orca-go/common/health"
	"github.com/stablyai/orca-go/common/logging"
	"github.com/stablyai/orca-go/common/secrets"
	"github.com/stablyai/orca-go/common/tracing"

	svcconfig "github.com/stablyai/orca-go/services/scm-integration-service/internal/config"

	"github.com/stablyai/orca-go/services/scm-integration-service/internal/adapter/azuredevops"
	"github.com/stablyai/orca-go/services/scm-integration-service/internal/adapter/bitbucket"
	"github.com/stablyai/orca-go/services/scm-integration-service/internal/adapter/credentialbroker"
	"github.com/stablyai/orca-go/services/scm-integration-service/internal/adapter/gitea"
	scmgithub "github.com/stablyai/orca-go/services/scm-integration-service/internal/adapter/github"
	scmgitlab "github.com/stablyai/orca-go/services/scm-integration-service/internal/adapter/gitlab"
	scmgrpc "github.com/stablyai/orca-go/services/scm-integration-service/internal/adapter/grpc"
	"github.com/stablyai/orca-go/services/scm-integration-service/internal/adapter/oauth"
	"github.com/stablyai/orca-go/services/scm-integration-service/internal/adapter/oauthstate"
	"github.com/stablyai/orca-go/services/scm-integration-service/internal/adapter/postgres"
	"github.com/stablyai/orca-go/services/scm-integration-service/internal/adapter/providerregistry"
	"github.com/stablyai/orca-go/services/scm-integration-service/internal/domain"
	"github.com/stablyai/orca-go/services/scm-integration-service/internal/usecase"

	scmintegrationv1 "github.com/stablyai/orca-go/proto/gen/go/orca/scmintegration/v1"
)

// version is overridden at build time via -ldflags "-X main.version=...".
var version = "dev"

func main() {
	if err := run(); err != nil {
		slog.Error("scm-integration-service exited with error", slog.Any("error", err))
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

	// scm.rate_limit_cache (migrations/0001_init.up.sql) as of Phase 3
	// (docs/execution-plan.md §3) — this service's first real database
	// connection. webhook_delivery_log lives in the same migration but has
	// no writer yet (schema-only — see README "Known gaps"); no repository
	// is wired for it here for that reason, not by oversight.
	dsn, err := secrets.DatabaseCredentialsFromFile(cfg.DatabaseCredentialsFile)
	if err != nil {
		return fmt.Errorf("resolving database credentials: %w", err)
	}
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return fmt.Errorf("connecting to postgres: %w", err)
	}
	defer pool.Close()
	rateLimitCache := postgres.New(pool)

	// githubProjectsAdapter/gitlabMRAdapter are the SAME instances registered
	// below in registry's map — one GitHub adapter satisfying both
	// usecase.ScmProvider and usecase.GitHubProjectsProvider, one GitLab
	// adapter satisfying both usecase.ScmProvider and
	// usecase.GitLabMergeRequestProvider (SOL-012/SOL-013's "still one
	// adapter, not a second client" design note).
	githubProjectsAdapter := scmgithub.New(nil, cfg.GitHubBaseURL)
	gitlabMRAdapter := scmgitlab.New(nil, cfg.GitLabBaseURL)
	registry := providerregistry.New(map[domain.ScmProvider]usecase.ScmProvider{
		domain.ScmProviderGitHub:      githubProjectsAdapter,
		domain.ScmProviderGitLab:      gitlabMRAdapter,
		domain.ScmProviderBitbucket:   bitbucket.New(nil, cfg.BitbucketBaseURL),
		domain.ScmProviderAzureDevOps: azuredevops.New(nil, cfg.AzureDevOpsBaseURL),
		domain.ScmProviderGitea:       gitea.New(nil, cfg.GiteaBaseURL),
	})

	// One OAuthExchanger per provider (§9.1) — a provider whose OAuth app
	// isn't configured (empty ClientID) is left out of this map entirely,
	// so StartOAuthFlow reports SCM_PROVIDER_UNSUPPORTED for it instead of
	// attempting a doomed exchange against an empty client_id.
	oauthExchangers := map[domain.ScmProvider]usecase.OAuthExchanger{}
	for provider, providerCfg := range map[domain.ScmProvider]svcconfig.OAuthProviderConfig{
		domain.ScmProviderGitHub:      cfg.OAuth.GitHub,
		domain.ScmProviderGitLab:      cfg.OAuth.GitLab,
		domain.ScmProviderBitbucket:   cfg.OAuth.Bitbucket,
		domain.ScmProviderAzureDevOps: cfg.OAuth.AzureDevOps,
		domain.ScmProviderGitea:       cfg.OAuth.Gitea,
	} {
		if providerCfg.ClientID == "" {
			continue
		}
		oauthExchangers[provider] = oauth.New(nil, oauth.Config{
			AuthorizeURL: providerCfg.AuthorizeURL,
			TokenURL:     providerCfg.TokenURL,
			ClientID:     providerCfg.ClientID,
			ClientSecret: providerCfg.ClientSecret,
			Scope:        providerCfg.Scope,
		})
	}
	oauthRegistry := providerregistry.NewOAuth(oauthExchangers)
	stateCodec := oauthstate.New(cfg.OAuthStateSecret)

	// Real credential-broker-service connection — Epic B
	// (docs/execution-plan.md §8). Insecure transport credentials here are
	// a local-dev/scaffold convenience only; production deploys terminate
	// mTLS via the service mesh sidecar, per
	// architecture/07-security-architecture.md.
	brokerConn, err := grpc.NewClient(cfg.CredentialBrokerAddr, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return fmt.Errorf("dialing credential-broker-service at %s: %w", cfg.CredentialBrokerAddr, err)
	}
	defer func() { _ = brokerConn.Close() }()
	credentials := credentialbroker.New(brokerConn)

	listIssuesUC := usecase.NewListIssues(credentials, registry)
	createPullRequestUC := usecase.NewCreatePullRequest(credentials, registry)
	listPullRequestsUC := usecase.NewListPullRequests(credentials, registry)
	listWorkItemsUC := usecase.NewListWorkItems(credentials, registry)
	getRateLimitStatusUC := usecase.NewGetRateLimitStatus(credentials, registry, rateLimitCache)
	getAuthStatusUC := usecase.NewGetAuthStatus(credentials)
	startOAuthFlowUC := usecase.NewStartOAuthFlow(oauthRegistry, stateCodec, nil)
	completeOAuthFlowUC := usecase.NewCompleteOAuthFlow(oauthRegistry, stateCodec, credentials)
	revokeAuthUC := usecase.NewRevokeAuth(credentials)
	setIntegrationCredentialUC := usecase.NewSetIntegrationCredential(credentials)
	getIntegrationCredentialStatusUC := usecase.NewGetIntegrationCredentialStatus(credentials)
	listIntegrationCredentialsUC := usecase.NewListIntegrationCredentials(credentials)

	// SOL-012 shape 1/2 — GitHub PR/issue mutations + repo/branch resolution
	// (TASK-076). registry already fans out per-provider; these usecases
	// resolve the concrete adapter the same way every other usecase above
	// does.
	mergePullRequestUC := usecase.NewMergePullRequest(credentials, registry)
	requestPullRequestReviewersUC := usecase.NewRequestPullRequestReviewers(credentials, registry)
	removePullRequestReviewersUC := usecase.NewRemovePullRequestReviewers(credentials, registry)
	setPullRequestAutoMergeUC := usecase.NewSetPullRequestAutoMerge(credentials, registry)
	updateIssueUC := usecase.NewUpdateIssue(credentials, registry)
	updatePullRequestUC := usecase.NewUpdatePullRequest(credentials, registry)
	starRepositoryUC := usecase.NewStarRepository(credentials, registry)
	getPullRequestForBranchUC := usecase.NewGetPullRequestForBranch(credentials, registry)
	resolveRepoSlugUC := usecase.NewResolveRepoSlug(credentials, registry)

	// SOL-012 shape 3 — GitHub Projects v2 (TASK-079). githubProjectsAdapter
	// is the SAME *github.Client instance registered in registry's map below
	// — one GitHub adapter satisfying both usecase.ScmProvider and
	// usecase.GitHubProjectsProvider, per SOL-012's design note.
	listAccessibleProjectsUC := usecase.NewListAccessibleProjects(credentials, githubProjectsAdapter)
	resolveProjectRefUC := usecase.NewResolveProjectRef(credentials, githubProjectsAdapter)
	listProjectViewsUC := usecase.NewListProjectViews(credentials, githubProjectsAdapter)
	viewProjectTableUC := usecase.NewViewProjectTable(credentials, githubProjectsAdapter)
	updateProjectItemFieldUC := usecase.NewUpdateProjectItemField(credentials, githubProjectsAdapter)
	clearProjectItemFieldUC := usecase.NewClearProjectItemField(credentials, githubProjectsAdapter)
	getWorkItemDetailsBySlugUC := usecase.NewGetWorkItemDetailsBySlug(credentials, githubProjectsAdapter)
	updateIssueBySlugUC := usecase.NewUpdateIssueBySlug(credentials, githubProjectsAdapter)
	updatePullRequestBySlugUC := usecase.NewUpdatePullRequestBySlug(credentials, githubProjectsAdapter)
	updateIssueTypeBySlugUC := usecase.NewUpdateIssueTypeBySlug(credentials, githubProjectsAdapter)
	listIssueTypesBySlugUC := usecase.NewListIssueTypesBySlug(credentials, githubProjectsAdapter)
	listAssignableUsersBySlugUC := usecase.NewListAssignableUsersBySlug(credentials, githubProjectsAdapter)
	listLabelsBySlugUC := usecase.NewListLabelsBySlug(credentials, githubProjectsAdapter)
	addIssueCommentBySlugUC := usecase.NewAddIssueCommentBySlug(credentials, githubProjectsAdapter)
	updateIssueCommentBySlugUC := usecase.NewUpdateIssueCommentBySlug(credentials, githubProjectsAdapter)
	deleteIssueCommentBySlugUC := usecase.NewDeleteIssueCommentBySlug(credentials, githubProjectsAdapter)

	// SOL-013 — GitLab-specific (TASK-084). gitlabMRAdapter is the SAME
	// *gitlab.Client instance registered in registry's map below.
	listMergeRequestsUC := usecase.NewListMergeRequests(credentials, gitlabMRAdapter)
	resolveMergeRequestDiscussionUC := usecase.NewResolveMergeRequestDiscussion(credentials, gitlabMRAdapter)
	getWorkItemDetailsUC := usecase.NewGetWorkItemDetails(credentials, gitlabMRAdapter)

	// SOL-014 — hostedReview.getCreationEligibility (TASK-088). Reuses the
	// same getAuthStatusUC instance the GetAuthStatus RPC already uses.
	checkHostedReviewEligibilityUC := usecase.NewCheckHostedReviewEligibility(credentials, registry, getAuthStatusUC)

	grpcServer := grpc.NewServer(grpcmw.ChainUnary(logger))
	scmintegrationv1.RegisterScmIntegrationServiceServer(grpcServer, scmgrpc.New(
		listIssuesUC, createPullRequestUC, listPullRequestsUC, listWorkItemsUC, getRateLimitStatusUC,
		getAuthStatusUC, startOAuthFlowUC, completeOAuthFlowUC, revokeAuthUC,
		mergePullRequestUC, requestPullRequestReviewersUC, removePullRequestReviewersUC,
		setPullRequestAutoMergeUC, updateIssueUC, updatePullRequestUC, starRepositoryUC, getPullRequestForBranchUC, resolveRepoSlugUC,
		listAccessibleProjectsUC, resolveProjectRefUC, listProjectViewsUC, viewProjectTableUC,
		updateProjectItemFieldUC, clearProjectItemFieldUC, getWorkItemDetailsBySlugUC,
		updateIssueBySlugUC, updatePullRequestBySlugUC, updateIssueTypeBySlugUC,
		listIssueTypesBySlugUC, listAssignableUsersBySlugUC, listLabelsBySlugUC,
		addIssueCommentBySlugUC, updateIssueCommentBySlugUC, deleteIssueCommentBySlugUC,
		listMergeRequestsUC, resolveMergeRequestDiscussionUC, getWorkItemDetailsUC,
		checkHostedReviewEligibilityUC,
		setIntegrationCredentialUC, getIntegrationCredentialStatusUC, listIntegrationCredentialsUC,
	))
	reflection.Register(grpcServer) // convenient for grpcurl during local dev; keep enabled behind the mesh, not the public internet

	healthSrv := health.New()
	healthSrv.Register("postgres", func() error {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		return pool.Ping(ctx)
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
		logger.Info("scm-integration-service grpc listening", slog.Int("port", cfg.GRPCPort))
		if err := grpcServer.Serve(lis); err != nil {
			errCh <- fmt.Errorf("grpc server: %w", err)
		}
	}()

	go func() {
		logger.Info("scm-integration-service http (health) listening", slog.Int("port", cfg.HTTPPort))
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
