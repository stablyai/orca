// Command server is project-service's composition root — the only place
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
	"github.com/stablyai/orca-go/common/secrets"
	"github.com/stablyai/orca-go/common/tracing"

	svcconfig "github.com/stablyai/orca-go/services/project-service/internal/config"

	projectgrpc "github.com/stablyai/orca-go/services/project-service/internal/adapter/grpc"
	projectgrpcclient "github.com/stablyai/orca-go/services/project-service/internal/adapter/grpcclient"
	projectopaclient "github.com/stablyai/orca-go/services/project-service/internal/adapter/opaclient"
	projectpostgres "github.com/stablyai/orca-go/services/project-service/internal/adapter/postgres"
	"github.com/stablyai/orca-go/services/project-service/internal/usecase"

	authv1 "github.com/stablyai/orca-go/proto/gen/go/orca/auth/v1"
	projectv1 "github.com/stablyai/orca-go/proto/gen/go/orca/project/v1"
)

// version is overridden at build time via -ldflags "-X main.version=...".
var version = "dev"

func main() {
	if err := run(); err != nil {
		slog.Error("project-service exited with error", slog.Any("error", err))
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

	repo := projectpostgres.New(pool)
	repoRepo := projectpostgres.NewRepoRepository(pool)
	worktreeRepo := projectpostgres.NewWorktreeRepository(pool)
	projectGroupRepo := projectpostgres.NewProjectGroupRepository(pool)
	folderWorkspaceRepo := projectpostgres.NewFolderWorkspaceRepository(pool)
	hostSetupRepo := projectpostgres.NewHostSetupRepository(pool)
	sourceProjectRepo := projectpostgres.NewSourceProjectRepository(pool)
	sparsePresetRepo := projectpostgres.NewSparsePresetRepository(pool)

	// Real clients — Epic C (docs/execution-plan.md §10, 2026-08-17) closed
	// the gap these were previously stubs for. Dialed lazily (doesn't block
	// startup) — see internal/adapter/grpcclient's doc comments.
	workflowChecker, err := projectgrpcclient.NewWorkflowExecutionChecker(cfg.WorkflowServiceAddr)
	if err != nil {
		return fmt.Errorf("dialing workflow-service: %w", err)
	}
	defer func() { _ = workflowChecker.Close() }()

	taskChecker, err := projectgrpcclient.NewTaskExecutionChecker(cfg.TaskServiceAddr)
	if err != nil {
		return fmt.Errorf("dialing task-service: %w", err)
	}
	defer func() { _ = taskChecker.Close() }()

	devServerRelay, err := projectgrpcclient.NewDevServerRelay(cfg.InfraFleetServiceAddr)
	if err != nil {
		return fmt.Errorf("dialing infra-fleet-service: %w", err)
	}
	defer func() { _ = devServerRelay.Close() }()

	devServerLister, err := projectgrpcclient.NewInfraFleetDevServerLister(cfg.InfraFleetServiceAddr)
	if err != nil {
		return fmt.Errorf("dialing infra-fleet-service (dev server lister): %w", err)
	}
	defer func() { _ = devServerLister.Close() }()

	// Audit-append client (TASK-BE-018/019, CR-RBAC-005) — requireProjectAccess/
	// requireRepoAccess (internal/usecase/authorization.go) use this to record
	// every OPA allow/deny decision to auth-service's audit_log. Lazy dial
	// (grpc.NewClient doesn't block on connect), same convention as every
	// other outbound client above.
	authConn, err := grpc.NewClient(cfg.AuthServiceAddr, grpc.WithTransportCredentials(insecure.NewCredentials()), grpc.WithStatsHandler(otelgrpc.NewClientHandler()))
	if err != nil {
		return fmt.Errorf("dialing auth-service: %w", err)
	}
	defer func() { _ = authConn.Close() }()
	usecase.SetAuditClient(auditclient.New(authv1.NewAuthServiceClient(authConn)))

	// Shared embedded-OPA evaluator (common/policy) for project-role/
	// global-admin authorization — mirrors auth-service/annotation-service/
	// task-service's own composition-root wiring. One Evaluator, pointed at
	// the same orca-authz bundle, shared by every OPA-gated usecase below.
	evaluator := policy.NewEvaluator(cfg.OPABundlePath)
	if err := evaluator.Warm(ctx, "data.orca.authz.project.allow"); err != nil {
		return fmt.Errorf("project-service: OPA bundle failed to load at startup (bundle path %q): %w", cfg.OPABundlePath, err)
	}
	opa := projectopaclient.New(evaluator)

	createProjectUC := usecase.NewCreateProject(repo)
	getProjectUC := usecase.NewGetProject(repo, opa)
	listProjectsUC := usecase.NewListProjects(repo)
	addMemberUC := usecase.NewAddMember(repo, opa)
	listMembersUC := usecase.NewListMembers(repo, opa)
	removeMemberUC := usecase.NewRemoveMember(repo, opa)
	updateMemberRoleUC := usecase.NewUpdateMemberRole(repo, opa)
	rebindDevServerUC := usecase.NewRebindDevServer(repo, workflowChecker, taskChecker, opa)
	rebindRepoDevServerUC := usecase.NewRebindRepoDevServer(repoRepo, repo, opa, workflowChecker, taskChecker, devServerLister)
	updateProjectUC := usecase.NewUpdateProject(repo, opa)
	deleteProjectUC := usecase.NewDeleteProject(repo, workflowChecker, taskChecker, opa)

	// repo (usecase.ProjectRepository) satisfies usecase.MembershipRepository
	// structurally — passed as the membership-lookup port to usecases whose
	// primary repository dependency is RepoRepository/WorktreeRepository
	// instead. See usecase.MembershipRepository's doc comment.
	addRepoUC := usecase.NewAddRepo(repoRepo, repo, opa, devServerLister)
	listReposUC := usecase.NewListRepos(repoRepo, repo, opa)
	reorderReposUC := usecase.NewReorderRepos(repoRepo, repo, opa)
	removeRepoUC := usecase.NewRemoveRepo(repoRepo, repo, opa)
	updateRepoUC := usecase.NewUpdateRepo(repoRepo, repo, opa)
	getRepoUC := usecase.NewGetRepo(repoRepo)
	assignRepoToProjectUC := usecase.NewAssignRepoToProject(repoRepo, repo, opa)

	addRepoMemberUC := usecase.NewAddRepoMember(repoRepo, repo, opa)
	listRepoMembersUC := usecase.NewListRepoMembers(repoRepo, repo, opa)
	removeRepoMemberUC := usecase.NewRemoveRepoMember(repoRepo, repo, opa)
	updateRepoMemberRoleUC := usecase.NewUpdateRepoMemberRole(repoRepo, repo, opa)

	recordWorktreeCreatedUC := usecase.NewRecordWorktreeCreated(worktreeRepo)
	recordWorktreeRemovedUC := usecase.NewRecordWorktreeRemoved(worktreeRepo)
	listWorktreesUC := usecase.NewListWorktrees(worktreeRepo, repo, opa)
	setWorktreeActivationUC := usecase.NewSetWorktreeActivation(worktreeRepo)
	renameWorktreeUC := usecase.NewRenameWorktree(worktreeRepo)
	updateWorktreeMetaUC := usecase.NewUpdateWorktreeMeta(worktreeRepo)
	setWorktreeLineageUC := usecase.NewSetWorktreeLineage(worktreeRepo)
	listWorktreeLineageUC := usecase.NewListWorktreeLineage(worktreeRepo)

	createProjectGroupUC := usecase.NewCreateProjectGroup(projectGroupRepo)
	updateProjectGroupUC := usecase.NewUpdateProjectGroup(projectGroupRepo)
	deleteProjectGroupUC := usecase.NewDeleteProjectGroup(projectGroupRepo)
	listProjectGroupsUC := usecase.NewListProjectGroups(projectGroupRepo)
	moveProjectUC := usecase.NewMoveProject(repo, projectGroupRepo, opa)
	scanNestedUC := usecase.NewScanNested(devServerRelay)
	importNestedUC := usecase.NewImportNested(projectGroupRepo)

	createHostSetupUC := usecase.NewCreateHostSetup(hostSetupRepo, devServerLister)
	listHostSetupsUC := usecase.NewListHostSetups(hostSetupRepo)
	updateHostSetupUC := usecase.NewUpdateHostSetup(hostSetupRepo)
	deleteHostSetupUC := usecase.NewDeleteHostSetup(hostSetupRepo)
	setupExistingFolderUC := usecase.NewSetupExistingFolder(hostSetupRepo, repo, repoRepo, devServerRelay)

	folderWorkspaceUC := usecase.NewFolderWorkspaceUseCase(folderWorkspaceRepo)

	// repo (usecase.ProjectRepository) satisfies usecase.MembershipRepository
	// structurally — same reasoning as the repo/worktree usecases above.
	linkSourceProjectUC := usecase.NewLinkSourceProject(sourceProjectRepo, repo, opa)
	unlinkSourceProjectUC := usecase.NewUnlinkSourceProject(sourceProjectRepo, repo, opa)
	listSourceProjectsUC := usecase.NewListSourceProjects(sourceProjectRepo, repo, opa)
	getSharedProjectDataUC := usecase.NewGetSharedProjectData(repo, repoRepo, worktreeRepo, sourceProjectRepo, repo, opa)

	// repo (usecase.ProjectRepository) satisfies usecase.RepoMembershipRepository
	// structurally too (via repoRepo's own GetRepoMembership) — same
	// reasoning as every repo-scoped usecase above.
	listSparsePresetsUC := usecase.NewListSparsePresets(sparsePresetRepo, repoRepo, repo, opa)
	saveSparsePresetUC := usecase.NewSaveSparsePreset(sparsePresetRepo, repoRepo, repo, opa)
	removeSparsePresetUC := usecase.NewRemoveSparsePreset(sparsePresetRepo, repoRepo, repo, opa)

	grpcServer := grpc.NewServer(grpcmw.ChainUnary(logger), grpcmw.StatsHandler())
	projectv1.RegisterProjectServiceServer(grpcServer, projectgrpc.New(projectgrpc.Deps{
		CreateProject:       createProjectUC,
		GetProject:          getProjectUC,
		ListProjects:        listProjectsUC,
		AddMember:           addMemberUC,
		RebindDevServer:     rebindDevServerUC,
		RebindRepoDevServer: rebindRepoDevServerUC,
		UpdateProject:       updateProjectUC,
		DeleteProject:       deleteProjectUC,

		ListMembers:      listMembersUC,
		RemoveMember:     removeMemberUC,
		UpdateMemberRole: updateMemberRoleUC,

		AddRepo:             addRepoUC,
		ListRepos:           listReposUC,
		ReorderRepos:        reorderReposUC,
		RemoveRepo:          removeRepoUC,
		UpdateRepo:          updateRepoUC,
		GetRepo:             getRepoUC,
		AssignRepoToProject: assignRepoToProjectUC,

		AddRepoMember:        addRepoMemberUC,
		ListRepoMembers:      listRepoMembersUC,
		RemoveRepoMember:     removeRepoMemberUC,
		UpdateRepoMemberRole: updateRepoMemberRoleUC,

		RecordWorktreeCreated: recordWorktreeCreatedUC,
		RecordWorktreeRemoved: recordWorktreeRemovedUC,
		ListWorktrees:         listWorktreesUC,
		SetWorktreeActivation: setWorktreeActivationUC,
		RenameWorktree:        renameWorktreeUC,
		UpdateWorktreeMeta:    updateWorktreeMetaUC,
		SetWorktreeLineage:    setWorktreeLineageUC,
		ListWorktreeLineage:   listWorktreeLineageUC,

		CreateProjectGroup: createProjectGroupUC,
		UpdateProjectGroup: updateProjectGroupUC,
		DeleteProjectGroup: deleteProjectGroupUC,
		ListProjectGroups:  listProjectGroupsUC,

		FolderWorkspaces: folderWorkspaceUC,
		MoveProject:      moveProjectUC,
		ScanNested:       scanNestedUC,
		ImportNested:     importNestedUC,

		CreateHostSetup:     createHostSetupUC,
		ListHostSetups:      listHostSetupsUC,
		UpdateHostSetup:     updateHostSetupUC,
		DeleteHostSetup:     deleteHostSetupUC,
		SetupExistingFolder: setupExistingFolderUC,

		LinkSourceProject:    linkSourceProjectUC,
		UnlinkSourceProject:  unlinkSourceProjectUC,
		ListSourceProjects:   listSourceProjectsUC,
		GetSharedProjectData: getSharedProjectDataUC,

		ListSparsePresets:  listSparsePresetsUC,
		SaveSparsePreset:   saveSparsePresetUC,
		RemoveSparsePreset: removeSparsePresetUC,
	}))
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
		logger.Info("project-service grpc listening", slog.Int("port", cfg.GRPCPort))
		if err := grpcServer.Serve(lis); err != nil {
			errCh <- fmt.Errorf("grpc server: %w", err)
		}
	}()

	go func() {
		logger.Info("project-service http (health) listening", slog.Int("port", cfg.HTTPPort))
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
