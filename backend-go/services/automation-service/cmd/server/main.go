// Command server is automation-service's composition root — the only place
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
	"go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/reflection"

	"github.com/stablyai/orca-go/common/grpcmw"
	"github.com/stablyai/orca-go/common/health"
	"github.com/stablyai/orca-go/common/logging"
	"github.com/stablyai/orca-go/common/tracing"

	svcconfig "github.com/stablyai/orca-go/services/automation-service/internal/config"

	automationgrpc "github.com/stablyai/orca-go/services/automation-service/internal/adapter/grpc"
	"github.com/stablyai/orca-go/services/automation-service/internal/adapter/grpc/interceptors"
	"github.com/stablyai/orca-go/services/automation-service/internal/adapter/grpcclient"
	automationpostgres "github.com/stablyai/orca-go/services/automation-service/internal/adapter/postgres"
	"github.com/stablyai/orca-go/services/automation-service/internal/adapter/scheduler"
	"github.com/stablyai/orca-go/services/automation-service/internal/usecase"

	automationv1 "github.com/stablyai/orca-go/proto/gen/go/orca/automation/v1"
)

// version is overridden at build time via -ldflags "-X main.version=...".
var version = "dev"

func main() {
	if err := run(); err != nil {
		slog.Error("automation-service exited with error", slog.Any("error", err))
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

	automationRepo := automationpostgres.NewAutomationRepository(pool)
	runRepo := automationpostgres.NewAutomationRunRepository(pool)

	// Real gRPC connection to workflow-service — RunNow's whole reason for
	// existing (see automation-service.md §2/§6). Insecure transport
	// credentials here are a local-dev/scaffold convenience only; production
	// deploys terminate mTLS via the service mesh sidecar, per
	// architecture/07-security-architecture.md, not a disabled-security
	// choice made in application code.
	workflowConn, err := grpc.NewClient(cfg.WorkflowServiceAddr, grpc.WithTransportCredentials(insecure.NewCredentials()), grpc.WithStatsHandler(otelgrpc.NewClientHandler()))
	if err != nil {
		return fmt.Errorf("dialing workflow-service at %s: %w", cfg.WorkflowServiceAddr, err)
	}
	defer func() { _ = workflowConn.Close() }()
	workflowExecutor := grpcclient.New(workflowConn)

	// CR-AUTO-003/TASK-BE-AUTO-006 + TASK-BE-AUTO-004's rewire: RunNow now
	// dispatches through ExecuteAutomationChain internally (see
	// usecase.NewRunNow's doc comment), so create_pr action dispatch needs
	// a real PullRequestCreator here — same insecure-transport-credentials
	// local-dev/scaffold convention as workflowConn above (production
	// terminates mTLS via the service mesh sidecar).
	scmConn, err := grpc.NewClient(cfg.ScmIntegrationServiceAddr, grpc.WithTransportCredentials(insecure.NewCredentials()), grpc.WithStatsHandler(otelgrpc.NewClientHandler()))
	if err != nil {
		return fmt.Errorf("dialing scm-integration-service at %s: %w", cfg.ScmIntegrationServiceAddr, err)
	}
	defer func() { _ = scmConn.Close() }()
	pullRequestCreator := grpcclient.NewScmClient(scmConn)

	createAutomationUC := usecase.NewCreateAutomation(automationRepo)
	runNowUC := usecase.NewRunNow(automationRepo, runRepo, workflowExecutor, usecase.WithPullRequestCreator(pullRequestCreator))
	listRunsUC := usecase.NewListRuns(runRepo)
	handleExternalTriggerUC := usecase.NewHandleExternalTrigger(runNowUC)
	listAutomationsUC := usecase.NewListAutomations(automationRepo)
	updateAutomationUC := usecase.NewUpdateAutomation(automationRepo)
	deleteAutomationUC := usecase.NewDeleteAutomation(automationRepo)

	// TASK-BE-AUTO-008: a second ChainUnaryInterceptor option composes with
	// grpcmw.ChainUnary's (grpc-go appends chainUnaryInts across multiple
	// options, executed in registration order) — this stays
	// automation-service-local, not a common/grpcmw change, matching
	// credential-broker-service's precedent of not extending the shared
	// interceptor stack for a single service's own gate.
	grpcServer := grpc.NewServer(
		grpcmw.ChainUnary(logger),
		grpc.ChainUnaryInterceptor(interceptors.RequireTenantForExternalTrigger()),
		grpcmw.StatsHandler(),
	)
	automationv1.RegisterAutomationServiceServer(grpcServer, automationgrpc.New(
		createAutomationUC, runNowUC, listRunsUC, handleExternalTriggerUC,
		listAutomationsUC, updateAutomationUC, deleteAutomationUC,
	))
	reflection.Register(grpcServer) // convenient for grpcurl during local dev; keep enabled behind the mesh, not the public internet

	// In-process scheduler ticker — see automation-service.md §7. Every
	// replica runs one; automationRepo (postgres.AutomationRepository) also
	// implements usecase.DueAutomationClaimer's SKIP LOCKED claim query, so
	// concurrent replicas' ticks never dispatch the same due occurrence
	// twice. Started as a goroutine sharing the same top-level shutdown
	// ctx every other goroutine here watches.
	schedulerTicker := scheduler.New(automationRepo, runNowUC, cfg.SchedulerInterval, cfg.SchedulerBatchSize, logger)
	go schedulerTicker.Run(ctx)

	healthSrv := health.New()
	healthSrv.Register("postgres", func() error {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		return pool.Ping(ctx)
	})
	healthSrv.Register("workflow-service", func() error {
		state := workflowConn.GetState()
		// Idle/Connecting are not failures — the connection is lazy and
		// established on first use; only a confirmed-bad state should pull
		// this replica out of readiness.
		if state.String() == "TRANSIENT_FAILURE" {
			return fmt.Errorf("workflow-service connection state: %s", state)
		}
		return nil
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
		logger.Info("automation-service grpc listening", slog.Int("port", cfg.GRPCPort))
		if err := grpcServer.Serve(lis); err != nil {
			errCh <- fmt.Errorf("grpc server: %w", err)
		}
	}()

	go func() {
		logger.Info("automation-service http (health) listening", slog.Int("port", cfg.HTTPPort))
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
	// standards/production-readiness-checklist.md. schedulerTicker.Done()
	// waits for any in-flight tick to finish committing its claim batch
	// rather than abandoning it mid-dispatch — ctx is already cancelled at
	// this point (it's the same ctx Run watches), so this only waits for
	// work already underway, never starts new work.
	grpcServer.GracefulStop()
	<-schedulerTicker.Done()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = httpServer.Shutdown(shutdownCtx)

	return nil
}
