// Command server is tenant-service's composition root — the only place
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
	"sync"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/grpc"
	"google.golang.org/grpc/reflection"

	"github.com/stablyai/orca-go/common/eventbus"
	"github.com/stablyai/orca-go/common/grpcmw"
	"github.com/stablyai/orca-go/common/health"
	"github.com/stablyai/orca-go/common/logging"
	"github.com/stablyai/orca-go/common/tracing"

	svcconfig "github.com/stablyai/orca-go/services/tenant-service/internal/config"

	tenantcache "github.com/stablyai/orca-go/services/tenant-service/internal/adapter/cache"
	tenanteventbus "github.com/stablyai/orca-go/services/tenant-service/internal/adapter/eventbus"
	tenantgrpc "github.com/stablyai/orca-go/services/tenant-service/internal/adapter/grpc"
	tenantpostgres "github.com/stablyai/orca-go/services/tenant-service/internal/adapter/postgres"
	"github.com/stablyai/orca-go/services/tenant-service/internal/adapter/scmstarcheck"
	"github.com/stablyai/orca-go/services/tenant-service/internal/usecase"

	scmintegrationv1 "github.com/stablyai/orca-go/proto/gen/go/orca/scmintegration/v1"
	tenantv1 "github.com/stablyai/orca-go/proto/gen/go/orca/tenant/v1"
)

// version is overridden at build time via -ldflags "-X main.version=...".
var version = "dev"

func main() {
	if err := run(); err != nil {
		slog.Error("tenant-service exited with error", slog.Any("error", err))
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

	dsn := cfg.DatabaseDSN
	if dsn == "" {
		return errors.New("DATABASE_DSN is required (or a Vault-Agent-rendered credentials file — not wired in this scaffold)")
	}
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return fmt.Errorf("connecting to postgres: %w", err)
	}
	defer pool.Close()

	companies := tenantpostgres.NewCompanyRepository(pool)
	departments := tenantpostgres.NewDepartmentRepository(pool)
	profiles := tenantpostgres.NewUserProfileRepository(pool)
	teams := tenantpostgres.NewTeamRepository(pool)
	companyEmailDomains := tenantpostgres.NewCompanyEmailDomainRepository(pool)
	workspaceSessions := tenantpostgres.NewUserWorkspaceSessionRepository(pool)
	starNagRepo := tenantpostgres.NewStarNagStateRepository(pool)

	// In-process LRU-with-TTL cache — a usecase-layer decorator, not
	// baked into adapter/postgres. See tenant-service.md §6 for why this
	// isn't a shared Redis read-through cache.
	profileCache := tenantcache.NewLRUTTLCache(tenantcache.DefaultCapacity)

	healthSrv := health.New()
	healthSrv.Register("postgres", func() error {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		return pool.Ping(ctx)
	})

	// Best-effort cross-replica profile-cache invalidation broadcast (Epic F,
	// docs/execution-plan.md). Unlike every other NATS-consuming service in
	// this scaffold, an unreachable NATS here must not be fatal: tenant-service
	// sits on the critical path for every other service's tenant resolution
	// (§3 Phase 4 — "do this last, everything depends on it"), so it degrades
	// to today's TTL-bounded-only staleness instead of crash-looping.
	var invalidationPublisher usecase.CacheInvalidationPublisher
	// starNagVisibilityPublisher is set from the SAME underlying
	// *tenanteventbus.Publisher instance invalidationPublisher uses when
	// NATS is reachable (one struct implements both interfaces) — see
	// TASK-014. Also nil (best-effort push skipped) when NATS is
	// unreachable, same degrade posture as invalidationPublisher.
	var starNagVisibilityPublisher usecase.StarNagVisibilityPublisher
	var consumerWG sync.WaitGroup
	pub, cons, closeBus, err := eventbus.Connect(ctx, cfg.NATSURL)
	if err != nil {
		logger.WarnContext(ctx, "eventbus unavailable, profile-cache invalidation stays TTL-bounded only", slog.Any("error", err))
	} else {
		defer func() { _ = closeBus() }()
		if err := pub.EnsureStream(ctx, tenanteventbus.StreamName, []string{"orca.tenant.>"}); err != nil {
			logger.WarnContext(ctx, "failed to ensure jetstream stream", slog.Any("error", err))
		} else {
			sharedPublisher := tenanteventbus.New(pub)
			invalidationPublisher = sharedPublisher
			starNagVisibilityPublisher = sharedPublisher
			healthSrv.Register("nats", func() error { return nil }) // presence-only: a real liveness probe would ping the connection

			invalidationConsumer := tenanteventbus.NewConsumer(cons, profileCache)
			consumerWG.Add(1)
			go func() {
				defer consumerWG.Done()
				invalidationConsumer.Run(ctx, logger)
			}()
		}
	}

	createCompanyUC := usecase.NewCreateCompany(companies)
	getCompanyUC := usecase.NewGetCompany(companies)
	listCompaniesUC := usecase.NewListCompanies(companies)
	validateTenantUC := usecase.NewValidateTenant(companies)
	createDepartmentUC := usecase.NewCreateDepartment(companies, departments)
	setUserDepartmentUC := usecase.NewSetUserDepartment(departments, profiles, profileCache, invalidationPublisher)
	baseGetResolvedProfileUC := usecase.NewGetResolvedProfile(companies, departments, profiles, teams)
	getResolvedProfileUC := usecase.NewCachedGetResolvedProfile(baseGetResolvedProfileUC, profileCache, usecase.DefaultProfileCacheTTL)
	createTeamUC := usecase.NewCreateTeam(companies, teams)
	addTeamMemberUC := usecase.NewAddTeamMember(teams, profileCache, invalidationPublisher)
	listTeamMembersUC := usecase.NewListTeamMembers(teams)
	getUserProfileUC := usecase.NewGetUserProfile(profiles)
	listDepartmentsUC := usecase.NewListDepartments(departments)
	updateCompanyUC := usecase.NewUpdateCompany(companies, profiles, profileCache, invalidationPublisher)
	updateDepartmentUC := usecase.NewUpdateDepartment(departments, profiles, profileCache, invalidationPublisher)
	updateUserProfileUC := usecase.NewUpdateUserProfile(profiles, profileCache, invalidationPublisher)
	listTeamsUC := usecase.NewListTeams(teams)
	listTeamsForUserUC := usecase.NewListTeamsForUser(teams)
	removeTeamMemberUC := usecase.NewRemoveTeamMember(teams, profileCache, invalidationPublisher)
	getOnboardingStateUC := usecase.NewGetOnboardingState(profiles)
	setOnboardingStateUC := usecase.NewSetOnboardingState(profiles)
	addCompanyEmailDomainUC := usecase.NewAddCompanyEmailDomain(companies, companyEmailDomains)
	removeCompanyEmailDomainUC := usecase.NewRemoveCompanyEmailDomain(companyEmailDomains)
	listCompanyEmailDomainsUC := usecase.NewListCompanyEmailDomains(companyEmailDomains)
	resolveCompanyByEmailDomainUC := usecase.NewResolveCompanyByEmailDomain(companyEmailDomains)

	// profiles doubles as usecase.ClientStateRepository (5 opaque per-user
	// JSON columns, CR-STORAGE-001/003/004b) — same repository struct as
	// GetOnboardingState/SetOnboardingState above, just a different set of
	// methods on it. workspaceSessions is its own table/repository
	// (CR-STORAGE-004a) — see BE-SOL-STORAGE-001 §3.
	getClientStateUC := usecase.NewGetClientState(profiles)
	setClientStateUC := usecase.NewSetClientState(profiles)
	getWorkspaceSessionUC := usecase.NewGetWorkspaceSession(workspaceSessions)
	setWorkspaceSessionUC := usecase.NewSetWorkspaceSession(workspaceSessions)
	patchWorkspaceSessionUC := usecase.NewPatchWorkspaceSession(workspaceSessions)

	// starCheck backs starNag.starOrca/agentValueMoment's "is this repo
	// starred" question — tenant-service's FIRST outbound synchronous
	// service dependency (TASK-013, SOL-005), now that
	// ScmIntegrationService.StarRepository exists (SOL-012/TASK-034/035).
	// Dialed with the same lazy, non-blocking grpc.NewClient pattern every
	// other service's own Dial helper uses — scm-integration-service being
	// briefly unreachable at startup must not fail tenant-service's boot.
	scmConn, err := scmstarcheck.Dial(cfg.ScmIntegrationServiceAddr)
	if err != nil {
		return fmt.Errorf("dialing scm-integration-service: %w", err)
	}
	defer func() { _ = scmConn.Close() }()
	starCheck := scmstarcheck.NewGrpcAdapter(scmintegrationv1.NewScmIntegrationServiceClient(scmConn))
	deferStarNagUC := usecase.NewDeferStarNag(starNagRepo, starNagVisibilityPublisher)
	completeStarNagUC := usecase.NewCompleteStarNag(starNagRepo, starNagVisibilityPublisher)
	disableStarNagUC := usecase.NewDisableStarNag(starNagRepo, starNagVisibilityPublisher)
	forceShowStarNagUC := usecase.NewForceShowStarNag(starNagRepo, starNagVisibilityPublisher)
	notifyStarNagOnboardingCompletedUC := usecase.NewNotifyStarNagOnboardingCompleted(starNagRepo)
	openWebStarNagUC := usecase.NewOpenWebStarNag(starNagRepo, starNagVisibilityPublisher)
	starOrcaFromNagUC := usecase.NewStarOrcaFromNag(starNagRepo, starCheck, starNagVisibilityPublisher)
	prepareStarNagAgentValueMomentUC := usecase.NewPrepareStarNagAgentValueMoment(starNagRepo, starCheck)
	showPreparedStarNagAgentValueMomentUC := usecase.NewShowPreparedStarNagAgentValueMoment(starNagRepo, starNagVisibilityPublisher)

	grpcServer := grpc.NewServer(grpcmw.ChainUnary(logger))
	tenantv1.RegisterTenantServiceServer(grpcServer, tenantgrpc.New(
		createCompanyUC,
		getCompanyUC,
		listCompaniesUC,
		validateTenantUC,
		createDepartmentUC,
		setUserDepartmentUC,
		getResolvedProfileUC,
		createTeamUC,
		addTeamMemberUC,
		listTeamMembersUC,
		getUserProfileUC,
		listDepartmentsUC,
		updateCompanyUC,
		updateDepartmentUC,
		updateUserProfileUC,
		listTeamsUC,
		listTeamsForUserUC,
		removeTeamMemberUC,
		getOnboardingStateUC,
		setOnboardingStateUC,
		addCompanyEmailDomainUC,
		removeCompanyEmailDomainUC,
		listCompanyEmailDomainsUC,
		resolveCompanyByEmailDomainUC,
		getClientStateUC,
		setClientStateUC,
		getWorkspaceSessionUC,
		setWorkspaceSessionUC,
		patchWorkspaceSessionUC,
		deferStarNagUC,
		completeStarNagUC,
		disableStarNagUC,
		forceShowStarNagUC,
		notifyStarNagOnboardingCompletedUC,
		openWebStarNagUC,
		starOrcaFromNagUC,
		prepareStarNagAgentValueMomentUC,
		showPreparedStarNagAgentValueMomentUC,
	))
	reflection.Register(grpcServer) // convenient for grpcurl during local dev; keep enabled behind the mesh, not the public internet

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
		logger.Info("tenant-service grpc listening", slog.Int("port", cfg.GRPCPort))
		if err := grpcServer.Serve(lis); err != nil {
			errCh <- fmt.Errorf("grpc server: %w", err)
		}
	}()

	go func() {
		logger.Info("tenant-service http (health) listening", slog.Int("port", cfg.HTTPPort))
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

	// Wait for the profile-invalidation consumer goroutine (if started) to
	// observe ctx cancellation and return, so it doesn't outlive the rest of
	// the server on shutdown — same pattern notification-service's main.go
	// uses for its own background consumer.
	consumerWG.Wait()

	return nil
}
