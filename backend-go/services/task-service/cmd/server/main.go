// Command server is task-service's composition root — the only place
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

	"github.com/stablyai/orca-go/common/auditclient"
	"github.com/stablyai/orca-go/common/grpcmw"
	"github.com/stablyai/orca-go/common/health"
	"github.com/stablyai/orca-go/common/logging"
	"github.com/stablyai/orca-go/common/policy"
	"github.com/stablyai/orca-go/common/tracing"

	svcconfig "github.com/stablyai/orca-go/services/task-service/internal/config"

	taskgrpc "github.com/stablyai/orca-go/services/task-service/internal/adapter/grpc"
	taskgrpcclient "github.com/stablyai/orca-go/services/task-service/internal/adapter/grpcclient"
	taskopaclient "github.com/stablyai/orca-go/services/task-service/internal/adapter/opaclient"
	taskpostgres "github.com/stablyai/orca-go/services/task-service/internal/adapter/postgres"
	"github.com/stablyai/orca-go/services/task-service/internal/usecase"

	aiproviderv1 "github.com/stablyai/orca-go/proto/gen/go/orca/aiprovider/v1"
	authv1 "github.com/stablyai/orca-go/proto/gen/go/orca/auth/v1"
	infrafleetv1 "github.com/stablyai/orca-go/proto/gen/go/orca/infrafleet/v1"
	taskv1 "github.com/stablyai/orca-go/proto/gen/go/orca/task/v1"
)

// version is overridden at build time via -ldflags "-X main.version=...".
var version = "dev"

func main() {
	if err := run(); err != nil {
		slog.Error("task-service exited with error", slog.Any("error", err))
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

	repo := taskpostgres.New(pool)

	// team-scope resolution and complex (orchestration-service) execution
	// dispatch are still STUBS — see internal/adapter/grpcclient's doc
	// comments and this service's README. simple execution dispatch and
	// the AI-relay path are real as of TASK-224, dialed against
	// infra-fleet-service and ai-provider-service below.
	teamScopeResolver := taskgrpcclient.NewStubTeamScopeResolver()
	complexExecutor := taskgrpcclient.NewStubComplexExecutor()

	infraFleetConn, err := taskgrpcclient.Dial(cfg.InfraFleetServiceAddr)
	if err != nil {
		return fmt.Errorf("dialing infra-fleet-service: %w", err)
	}
	defer func() { _ = infraFleetConn.Close() }()
	infraFleetClient := infrafleetv1.NewInfraFleetServiceClient(infraFleetConn)
	projectExecutionResolver := taskgrpcclient.NewProjectExecutionResolver(infraFleetClient)
	simpleExecutor := taskgrpcclient.NewSimpleExecutor(repo, projectExecutionResolver, infraFleetClient)
	aiCompleter := taskgrpcclient.NewAICompleter(infraFleetClient)

	aiProviderConn, err := taskgrpcclient.Dial(cfg.AIProviderServiceAddr)
	if err != nil {
		return fmt.Errorf("dialing ai-provider-service: %w", err)
	}
	defer func() { _ = aiProviderConn.Close() }()
	aiProviderClient := aiproviderv1.NewAiProviderServiceClient(aiProviderConn)
	aiProviderContextResolver := taskgrpcclient.NewAIProviderContextResolver(aiProviderClient)

	// opaEvaluator loads/compiles the orca-authz bundle once per distinct
	// query string (common/policy.Evaluator's own cache) and is shared by
	// every ResolvePermission call for this process's lifetime.
	opaEvaluator := policy.NewEvaluator(cfg.OPABundlePath)
	if err := opaEvaluator.Warm(ctx, "data.orca.authz.task.allow"); err != nil {
		return fmt.Errorf("task-service: OPA bundle failed to load at startup (bundle path %q): %w", cfg.OPABundlePath, err)
	}
	opaClient := taskopaclient.New(opaEvaluator)

	// Audit-append client (TASK-BE-018/020, CR-RBAC-005) — ResolvePermission
	// uses this to record every OPA allow/deny decision to auth-service's
	// audit_log. Lazy dial (grpc.NewClient doesn't block on connect), same
	// convention as every other outbound client above.
	authConn, err := grpc.NewClient(cfg.AuthServiceAddr, grpc.WithTransportCredentials(insecure.NewCredentials()), grpc.WithStatsHandler(otelgrpc.NewClientHandler()))
	if err != nil {
		return fmt.Errorf("dialing auth-service: %w", err)
	}
	defer func() { _ = authConn.Close() }()
	auditClient := auditclient.New(authv1.NewAuthServiceClient(authConn))

	createTaskUC := usecase.NewCreateTask(repo)
	getTaskUC := usecase.NewGetTask(repo)
	addEdgeUC := usecase.NewAddEdge(repo)
	grantUC := usecase.NewGrant(repo)
	resolvePermissionUC := usecase.NewResolvePermission(repo, repo, teamScopeResolver, opaClient, auditClient)
	executeTaskUC := usecase.NewExecuteTask(repo, repo, simpleExecutor, complexExecutor)
	hasActiveExecutionsUC := usecase.NewHasActiveExecutions(repo)
	listTasksUC := usecase.NewListTasks(repo)
	updateTaskUC := usecase.NewUpdateTask(repo)
	deleteTaskUC := usecase.NewDeleteTask(repo)
	getDependenciesUC := usecase.NewGetDependencies(repo, repo)
	aiDecomposeUC := usecase.NewAIDecompose(repo, aiProviderContextResolver, projectExecutionResolver, aiCompleter)
	// repo also implements usecase.TxRunner (internal/adapter/postgres's
	// RunInTx) — AIApply needs its create-subtask+add-edge loop to run in
	// one transaction (TASK-224 Gap 2), not the standalone createTaskUC/
	// addEdgeUC instances above (those stay wired to the plain CreateTask/
	// AddEdge RPCs, which don't need a shared transaction).
	aiApplyUC := usecase.NewAIApply(repo)

	grpcServer := grpc.NewServer(grpcmw.ChainUnary(logger), grpcmw.StatsHandler())
	taskv1.RegisterTaskServiceServer(grpcServer, taskgrpc.New(
		createTaskUC, getTaskUC, addEdgeUC, grantUC, resolvePermissionUC, executeTaskUC, hasActiveExecutionsUC,
		listTasksUC, updateTaskUC, deleteTaskUC, getDependenciesUC, aiDecomposeUC, aiApplyUC,
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
		logger.Info("task-service grpc listening", slog.Int("port", cfg.GRPCPort))
		if err := grpcServer.Serve(lis); err != nil {
			errCh <- fmt.Errorf("grpc server: %w", err)
		}
	}()

	go func() {
		logger.Info("task-service http (health) listening", slog.Int("port", cfg.HTTPPort))
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
