// Command server is orchestration-service's composition root — the only
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
	"google.golang.org/grpc/reflection"

	"github.com/stablyai/orca-go/common/grpcmw"
	"github.com/stablyai/orca-go/common/health"
	"github.com/stablyai/orca-go/common/logging"
	"github.com/stablyai/orca-go/common/tracing"

	svcconfig "github.com/stablyai/orca-go/services/orchestration-service/internal/config"

	orchgrpc "github.com/stablyai/orca-go/services/orchestration-service/internal/adapter/grpc"
	orchpostgres "github.com/stablyai/orca-go/services/orchestration-service/internal/adapter/postgres"
	"github.com/stablyai/orca-go/services/orchestration-service/internal/usecase"

	orchestrationv1 "github.com/stablyai/orca-go/proto/gen/go/orca/orchestration/v1"
)

// version is overridden at build time via -ldflags "-X main.version=...".
var version = "dev"

func main() {
	if err := run(); err != nil {
		slog.Error("orchestration-service exited with error", slog.Any("error", err))
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

	repo := orchpostgres.New(pool)

	// KeyedSerializer is wired ONCE here and shared by every usecase that
	// needs handle-serialized execution — a single shared instance is
	// required for the serialization guarantee to mean anything across
	// different usecases racing on the same key (orchestration-service.md
	// §6/§8).
	serializer := usecase.NewKeyedSerializer(0)

	createDispatchContextUC := usecase.NewCreateDispatchContext(repo, serializer)
	createGateUC := usecase.NewCreateGate(repo, serializer)
	resolveGateUC := usecase.NewResolveGate(repo, serializer)
	updateTaskStatusAndPromoteUC := usecase.NewUpdateTaskStatusAndPromote(repo, serializer)
	getDispatchContextForTaskUC := usecase.NewGetDispatchContextForTask(repo)
	listActiveDispatchContextsForUserUC := usecase.NewListActiveDispatchContextsForUser(repo)
	failDispatchUC := usecase.NewFailDispatch(repo)

	grpcServer := grpc.NewServer(grpcmw.ChainUnary(logger))
	orchestrationv1.RegisterOrchestrationServiceServer(grpcServer, orchgrpc.New(
		createDispatchContextUC, createGateUC, resolveGateUC, updateTaskStatusAndPromoteUC, getDispatchContextForTaskUC,
		listActiveDispatchContextsForUserUC, failDispatchUC,
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
		logger.Info("orchestration-service grpc listening", slog.Int("port", cfg.GRPCPort))
		if err := grpcServer.Serve(lis); err != nil {
			errCh <- fmt.Errorf("grpc server: %w", err)
		}
	}()

	go func() {
		logger.Info("orchestration-service http (health) listening", slog.Int("port", cfg.HTTPPort))
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
