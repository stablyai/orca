// Command server is infra-fleet-service's composition root — the only place
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

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/grpc"
	"google.golang.org/grpc/reflection"

	"github.com/stablyai/orca-go/common/eventbus"
	"github.com/stablyai/orca-go/common/grpcmw"
	"github.com/stablyai/orca-go/common/health"
	"github.com/stablyai/orca-go/common/logging"
	"github.com/stablyai/orca-go/common/outbox"
	"github.com/stablyai/orca-go/common/secrets"
	"github.com/stablyai/orca-go/common/tracing"

	svcconfig "github.com/stablyai/orca-go/services/infra-fleet-service/internal/config"

	infraagentwsserver "github.com/stablyai/orca-go/services/infra-fleet-service/internal/adapter/agentwsserver"
	infrabackendrelaysshprovisioner "github.com/stablyai/orca-go/services/infra-fleet-service/internal/adapter/backendrelaysshprovisioner"
	infradevserveragent "github.com/stablyai/orca-go/services/infra-fleet-service/internal/adapter/devserveragent"
	infraephemeralsshconn "github.com/stablyai/orca-go/services/infra-fleet-service/internal/adapter/ephemeralsshconn"
	infragrpc "github.com/stablyai/orca-go/services/infra-fleet-service/internal/adapter/grpc"
	infrapostgres "github.com/stablyai/orca-go/services/infra-fleet-service/internal/adapter/postgres"
	infrasshconn "github.com/stablyai/orca-go/services/infra-fleet-service/internal/adapter/sshconn"
	infrasshrelay "github.com/stablyai/orca-go/services/infra-fleet-service/internal/adapter/sshrelay"
	"github.com/stablyai/orca-go/services/infra-fleet-service/internal/usecase"

	infrafleetv1 "github.com/stablyai/orca-go/proto/gen/go/orca/infrafleet/v1"
)

// version is overridden at build time via -ldflags "-X main.version=...".
var version = "dev"

func main() {
	if err := run(); err != nil {
		slog.Error("infra-fleet-service exited with error", slog.Any("error", err))
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

	// One Repository backs DevServerRepository, ConnectionRepository,
	// ConnectionResolver, and FleetHealthPort; SshTargetStore is a separate
	// value over the same pool for SshTargetRepository/SshTargetResolver —
	// see internal/adapter/postgres's package doc comment for why they can't
	// be the same Go value.
	repo := infrapostgres.New(pool)
	sshTargetStore := infrapostgres.NewSshTargetStore(pool)
	terminalSessionStore := infrapostgres.NewTerminalSessionStore(pool)
	browserProfileStore := infrapostgres.NewBrowserProfileStore(pool)

	// relay-websocket (outbound dial) and direct-websocket (inbound accept,
	// wired below via agentwsserver) are both real, and so is relay-ssh now
	// (deploy agent/out/agent.js over SSH, launch it --stdio, real JSON-RPC
	// session — see adapter/sshrelay's package doc comment), wired in via a
	// Vault client used only for SSH cert issuance (sshconn.SSHCertIssuer).
	// vault.NewClient() only builds the API client object (no network call,
	// see common/secrets's doc comment) — construction failing means
	// VAULT_ADDR is malformed, not that Vault is unreachable, so this stays
	// a startup log warning + relay-ssh left unavailable, not a fatal error:
	// this service's core (dev-server registry, relay-websocket,
	// direct-websocket) has nothing to do with Vault and must not
	// crash-loop over one optional mode's dependency. ORCA_RELAY_BUNDLE_PATH
	// unset is the same kind of "leave relay-ssh unavailable" case, checked
	// lazily inside sshrelay.deploy rather than here, since it's still worth
	// constructing the provisioner (so config wiring is visibly complete)
	// even if deploy will fail until an operator sets the bundle path.
	agentCfg := infradevserveragent.LoadConfigFromEnv()
	var agentOpts []infradevserveragent.Option
	vaultClient, err := secrets.NewClient()
	if err != nil {
		logger.Warn("failed to construct Vault client — relay-ssh mode will report ErrConnectionModeNotImplemented", slog.Any("error", err))
	} else {
		sshConnector := infrasshconn.NewConnector(vaultClient, infrasshconn.LoadConfigFromEnv())
		sshRelayCfg := infrasshrelay.LoadConfigFromEnv(agentCfg.OrcaVersion)
		if sshRelayCfg.BundlePath == "" {
			logger.Warn("ORCA_RELAY_BUNDLE_PATH is not set — relay-ssh dev servers will fail to provision until it points at a built agent/out/agent.js")
		}
		provisioner := infrasshrelay.NewProvisioner(sshConnector, sshTargetStore, sshRelayCfg)
		agentOpts = append(agentOpts, infradevserveragent.WithRelaySSH(provisioner))
	}

	agentClient := infradevserveragent.New(agentCfg, logger, agentOpts...)
	defer agentClient.Close()

	// Transactional-outbox relay (mirrors usage-service's cmd/server/main.go
	// exactly) — PollFleetHealth enqueues a row on a dev server's
	// reachable=true -> false transition (see its own doc comment); this
	// relay is what actually gets those rows to NATS. NATS being
	// unreachable at startup is not fatal: rows still get written durably
	// (PollFleetHealth never touches NATS directly), they just queue up
	// unpublished until an operator restarts this process once NATS
	// recovers — same limitation every other NATS-consuming service here
	// already carries.
	var outboxRelay *outbox.Relay
	pub, _, closeBus, err := eventbus.Connect(ctx, cfg.NATSURL)
	if err != nil {
		logger.WarnContext(ctx, "eventbus unavailable, dev-server-disconnected alerts will queue until a future restart", slog.Any("error", err))
	} else {
		defer func() { _ = closeBus() }()
		if err := pub.EnsureStream(ctx, "INFRAFLEET", []string{"orca.infrafleet.>"}); err != nil {
			logger.WarnContext(ctx, "failed to ensure jetstream stream", slog.Any("error", err))
		} else {
			outboxRelay = outbox.NewRelay(repo, pub, outbox.DefaultConfig, logger)
		}
	}

	var outboxRelayWG sync.WaitGroup
	if outboxRelay != nil {
		outboxRelayWG.Add(1)
		go func() {
			defer outboxRelayWG.Done()
			outboxRelay.Run(ctx)
		}()
	}

	registerDevServerUC := usecase.NewRegisterDevServer(repo)
	resolveDirectWebSocketDevServerUC := usecase.NewResolveDirectWebSocketDevServer(repo)
	createSshTargetUC := usecase.NewCreateSshTarget(sshTargetStore)
	getFleetHealthUC := usecase.NewGetFleetHealth(repo)
	pollFleetHealthUC := usecase.NewPollFleetHealth(repo, repo, repo, agentClient, repo, terminalSessionStore, logger)
	scanWorkspacePortsUC := usecase.NewScanWorkspacePorts(repo, agentClient)
	listDevServersUC := usecase.NewListDevServers(repo)
	createConnectionUC := usecase.NewCreateConnection(repo)
	relayUC := usecase.NewRelay(repo, agentClient)
	relayByDevServerUC := usecase.NewRelayByDevServer(repo, agentClient)
	isDevServerConnectedUC := usecase.NewIsDevServerConnected(repo, agentClient)
	listSshTargetsUC := usecase.NewListSshTargets(sshTargetStore)
	getSshStateUC := usecase.NewGetSshState(sshTargetStore, repo, repo)
	establishConnectionUC := usecase.NewEstablishConnection(sshTargetStore, repo, repo, agentClient)
	killWorkspacePortUC := usecase.NewKillWorkspacePort(repo, agentClient)
	// TeardownConnection (BE-SOL-STORAGE-003 §5, TASK-BE-STORAGE-012) — the
	// confirmed-logout explicit-close path; repo implements both
	// ConnectionResolver (lookup) and ConnectionRepository (persist), same
	// dual-role convention as its use elsewhere in this file.
	teardownConnectionUC := usecase.NewTeardownConnection(repo, repo, terminalSessionStore, agentClient)

	// --- Terminal/PTY (TASK-185) --- one ConnectionStreamLimiter shared by
	// AttachPty across every stream this process serves.
	ptyStreamLimiter := usecase.NewConnectionStreamLimiter(0)
	// ephemeralVmRuntimeStore is constructed here (earlier than the rest of
	// the "Ephemeral VM" wiring block below) because SpawnTerminalSession
	// needs it too, for TASK-BE-EVM-007's environmentId resolution fallback
	// — the block below still uses this same instance.
	ephemeralVmRuntimeStore := infrapostgres.NewEphemeralVmRuntimeStore(pool)
	// resolveConnectionUC (TASK-BE-EVM-018, BE-SOL-EVM-004 §6c) needs
	// ephemeralVmRuntimeStore for its HiddenTargetID lookup — constructed
	// here, after that store exists, rather than up with the rest of the
	// "core dispatch" usecases above (which predate this dependency).
	resolveConnectionUC := usecase.NewResolveConnection(repo, ephemeralVmRuntimeStore)
	spawnTerminalSessionUC := usecase.NewSpawnTerminalSession(repo, repo, agentClient, terminalSessionStore, ephemeralVmRuntimeStore, cfg.ServerDeployment)
	resizeTerminalSessionUC := usecase.NewResizeTerminalSession(terminalSessionStore, repo, repo, agentClient)
	killTerminalSessionUC := usecase.NewKillTerminalSession(terminalSessionStore, repo, repo, agentClient)
	stopTerminalProcessUC := usecase.NewStopTerminalProcess(terminalSessionStore, repo, repo, agentClient)
	listTerminalSessionsUC := usecase.NewListTerminalSessions(terminalSessionStore)
	waitTerminalSessionUC := usecase.NewWaitTerminalSession(terminalSessionStore, repo, repo, agentClient)
	focusTerminalSessionUC := usecase.NewFocusTerminalSession(terminalSessionStore)
	getTerminalAgentStatusUC := usecase.NewGetTerminalAgentStatus(terminalSessionStore, repo, repo, agentClient)
	inspectTerminalProcessUC := usecase.NewInspectTerminalProcess(terminalSessionStore, repo, repo, agentClient)
	attachPtyUC := usecase.NewAttachPty(terminalSessionStore, repo, repo, agentClient, ptyStreamLimiter)
	screencastStreamLimiter := usecase.NewConnectionStreamLimiter(0)
	attachScreencastUC := usecase.NewAttachScreencast(repo, agentClient, screencastStreamLimiter)
	listBrowserProfilesUC := usecase.NewListBrowserProfiles(browserProfileStore)
	createBrowserProfileUC := usecase.NewCreateBrowserProfile(browserProfileStore, uuid.NewString)
	deleteBrowserProfileUC := usecase.NewDeleteBrowserProfile(browserProfileStore)

	// --- Emulator relay (TASK-048) / host capabilities relay (TASK-070) ---
	// Shipped-but-honestly-inert until agent/ gains device.*/host.capabilities
	// — see usecase.EmulatorRelay / usecase.GetHostCapabilities doc comments.
	emulatorRelayUC := usecase.NewEmulatorRelay(repo, agentClient)
	getHostCapabilitiesUC := usecase.NewGetHostCapabilities(repo, agentClient)

	// --- CR-DS-006 Phase 2 / CR-DS-007 / CR-DS-008 (dev server access control) ---
	devServerGroupStore := infrapostgres.NewDevServerGroupStore(pool)
	devServerGroupGrantStore := infrapostgres.NewDevServerGroupGrantStore(pool)
	devServerAccessRequestStore := infrapostgres.NewDevServerAccessRequestStore(pool)
	approveDevServerUC := usecase.NewApproveDevServer(repo)
	rejectDevServerUC := usecase.NewRejectDevServer(repo)
	assignDevServerGroupUC := usecase.NewAssignDevServerGroup(repo)
	createDevServerGroupUC := usecase.NewCreateDevServerGroup(devServerGroupStore)
	listDevServerGroupsUC := usecase.NewListDevServerGroups(devServerGroupStore)
	grantDevServerGroupAccessUC := usecase.NewGrantDevServerGroupAccess(devServerGroupGrantStore)
	revokeDevServerGroupAccessUC := usecase.NewRevokeDevServerGroupAccess(devServerGroupGrantStore)
	listDevServerGroupGrantsUC := usecase.NewListDevServerGroupGrants(devServerGroupGrantStore)
	listDevServersForUserUC := usecase.NewListDevServersForUser(repo, devServerGroupStore, devServerGroupGrantStore)
	createAccessRequestUC := usecase.NewCreateAccessRequest(devServerAccessRequestStore)
	listPendingAccessRequestsUC := usecase.NewListPendingAccessRequests(devServerAccessRequestStore)
	resolveAccessRequestUC := usecase.NewResolveAccessRequest(devServerAccessRequestStore, devServerGroupGrantStore)

	// --- Ephemeral VM (SOL-004 Group 1/2a, TASK-002/004) --- ephemeralVmRuntimeStore
	// itself is constructed earlier, alongside spawnTerminalSessionUC (see
	// that line's comment) — reused here.
	listEphemeralVmRuntimesUC := usecase.NewListEphemeralVmRuntimes(ephemeralVmRuntimeStore)
	// --- Ephemeral VM ssh-type provisioner wiring (TASK-BE-EVM-012/014) ---
	// Hướng A (agent-outbound) only — Hướng B (backend-relay-deploy,
	// TASK-BE-EVM-013) wires its own usecase.WithSshProvisioner option
	// separately; cfg.EphemeralVmSshMode's default
	// ("backend-relay-deploy") stays inert here until that wiring lands.
	ephemeralVmSshTargetStore := infrapostgres.NewEphemeralVmSshTargetStore(pool)
	var ephemeralVmRelayOpts []usecase.EphemeralVmRelayOption
	if cfg.EphemeralVmSshMode == "agent-outbound" {
		// GAP 1/2 FIX (TASK-BE-EVM-016, BE-SOL-EVM-004 §6a/§6b): no Vault
		// client and no devServer-resolver placeholder needed anymore —
		// AgentOutboundSshProvisioner no longer resolves credential
		// material from Vault (identityFile was never a Vault pointer,
		// see domain.EphemeralVmSshTarget's doc comment), and
		// EphemeralVmSshProvisioner.Provision now receives sourceDevServer
		// directly from EphemeralVmRelay.Provision instead of needing a
		// separate lookup port. repo satisfies usecase.ConnectionRepository
		// (used to register a real infra.connections row), same as it
		// already does for Hướng B just below.
		agentOutboundProvisioner := usecase.NewAgentOutboundSshProvisioner(
			agentClient, repo, ephemeralVmSshTargetStore)
		ephemeralVmRelayOpts = append(ephemeralVmRelayOpts, usecase.WithSshProvisioner(agentOutboundProvisioner))
	} else {
		// Hướng B (backend-relay-deploy, TASK-BE-EVM-013/017) — the default
		// mode (config.Load's EphemeralVmSshMode fail-safe default). Reuses
		// the EXACT same agent/out/agent.js deploy+launch+handshake
		// pipeline as the ordinary relay-ssh wiring just above
		// (infrasshrelay.Provisioner), only swapping auth
		// (adapter/ephemeralsshconn's recipe-credential dial instead of
		// adapter/sshconn's Vault-cert dial) — see
		// adapter/backendrelaysshprovisioner's package doc comment. Does
		// not call Vault at all (TASK-BE-EVM-017: credential bytes come
		// from DevServerAgentClient.ReadCredentialFile against the source
		// dev server instead), so it stays available even when Vault
		// client construction failed.
		backendRelaySshRelayCfg := infrasshrelay.LoadConfigFromEnv(agentCfg.OrcaVersion)
		if backendRelaySshRelayCfg.BundlePath == "" {
			logger.Warn("ORCA_RELAY_BUNDLE_PATH is not set — EPHEMERAL_VM_SSH_MODE=backend-relay-deploy ssh-type ephemeral VMs will fail to provision until it points at a built agent/out/agent.js")
		}
		// ephemeralVmSshTargetStore (TASK-BE-EVM-019, BE-SOL-EVM-004 §6d) is
		// the SAME store Hướng A's audit row uses (migrations/0015/0016) —
		// only one of Hướng A/B is active per deployment (EphemeralVmSshMode),
		// so no write-owner conflict; here it backs TOFU host-key
		// fingerprint persistence instead of the identity-path audit trail.
		backendRelaySshProvisioner := infrabackendrelaysshprovisioner.NewProvisioner(
			repo, repo, ephemeralVmRuntimeStore, agentClient,
			backendRelaySshRelayCfg, infraephemeralsshconn.LoadConfigFromEnv(), uuid.NewString,
			ephemeralVmSshTargetStore)
		ephemeralVmRelayOpts = append(ephemeralVmRelayOpts, usecase.WithSshProvisioner(backendRelaySshProvisioner))
	}
	ephemeralVmRelayUC := usecase.NewEphemeralVmRelay(repo, agentClient, ephemeralVmRuntimeStore, ephemeralVmRelayOpts...)

	// --- Fleet connectivity summary (CR-STORAGE-007, TASK-BE-STORAGE-006) ---
	getFleetConnectivitySummaryUC := usecase.NewGetFleetConnectivitySummary(repo)

	grpcServer := grpc.NewServer(grpcmw.ChainUnary(logger))
	infrafleetv1.RegisterInfraFleetServiceServer(grpcServer, infragrpc.New(
		registerDevServerUC,
		resolveConnectionUC,
		createSshTargetUC,
		getFleetHealthUC,
		scanWorkspacePortsUC,
		listDevServersUC,
		createConnectionUC,
		relayUC,
		listSshTargetsUC,
		getSshStateUC,
		establishConnectionUC,
		killWorkspacePortUC,
		spawnTerminalSessionUC,
		resizeTerminalSessionUC,
		killTerminalSessionUC,
		stopTerminalProcessUC,
		listTerminalSessionsUC,
		waitTerminalSessionUC,
		focusTerminalSessionUC,
		getTerminalAgentStatusUC,
		inspectTerminalProcessUC,
		attachPtyUC,
		attachScreencastUC,
		listBrowserProfilesUC,
		createBrowserProfileUC,
		deleteBrowserProfileUC,
		emulatorRelayUC,
		getHostCapabilitiesUC,
		approveDevServerUC,
		rejectDevServerUC,
		assignDevServerGroupUC,
		createDevServerGroupUC,
		listDevServerGroupsUC,
		grantDevServerGroupAccessUC,
		revokeDevServerGroupAccessUC,
		listDevServerGroupGrantsUC,
		listDevServersForUserUC,
		createAccessRequestUC,
		listPendingAccessRequestsUC,
		resolveAccessRequestUC,
		relayByDevServerUC,
		isDevServerConnectedUC,
		listEphemeralVmRuntimesUC,
		ephemeralVmRelayUC,
		getFleetConnectivitySummaryUC,
		teardownConnectionUC,
	))
	reflection.Register(grpcServer) // convenient for grpcurl during local dev; keep enabled behind the mesh, not the public internet

	healthSrv := health.New()
	healthSrv.Register("postgres", func() error {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		return pool.Ping(ctx)
	})

	// direct-websocket's inbound WS handler ("/agent") and token-issuance
	// endpoint ("/api/agent-token") share this service's existing HTTP
	// server/port rather than opening a new one — see
	// internal/adapter/agentwsserver's package doc comment. slotRegistry is
	// shared between the two so a POST /api/agent-token-issued slot is what
	// the WS handshake later validates against.
	agentWSCfg := infraagentwsserver.LoadConfigFromEnv(cfg.HTTPPort, agentCfg.OrcaVersion)
	if agentWSCfg.APISecret == "" {
		logger.Warn("ORCA_AGENT_API_SECRET is not set — POST/GET /api/agent-token will reject every request (fail-secure); direct-websocket dev servers cannot be registered until it is configured")
	}
	slotRegistry := infraagentwsserver.NewRegistry(infraagentwsserver.DefaultConnectTimeout)
	defer slotRegistry.Stop()
	agentWSServer := infraagentwsserver.New(slotRegistry, agentClient, agentWSCfg, logger)
	agentTokenIssuer := infraagentwsserver.NewTokenIssuer(slotRegistry, agentWSCfg, logger, resolveDirectWebSocketDevServerUC, ephemeralVmRuntimeStore)

	mux := http.NewServeMux()
	mux.Handle("/", healthSrv.Handler())
	mux.Handle("/agent", agentWSServer)
	mux.Handle("/api/agent-token", agentTokenIssuer)

	httpServer := &http.Server{
		Addr:    fmt.Sprintf(":%d", cfg.HTTPPort),
		Handler: mux,
	}

	errCh := make(chan error, 2)

	go func() {
		lis, err := net.Listen("tcp", fmt.Sprintf(":%d", cfg.GRPCPort))
		if err != nil {
			errCh <- fmt.Errorf("listening on grpc port: %w", err)
			return
		}
		logger.Info("infra-fleet-service grpc listening", slog.Int("port", cfg.GRPCPort))
		if err := grpcServer.Serve(lis); err != nil {
			errCh <- fmt.Errorf("grpc server: %w", err)
		}
	}()

	go func() {
		logger.Info("infra-fleet-service http (health) listening", slog.Int("port", cfg.HTTPPort))
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- fmt.Errorf("http server: %w", err)
		}
	}()

	// Fleet-health poller — specs/backend-go/services/infra-fleet-service.md
	// §8's 30s cadence. A poll failure never reaches errCh: one bad tick
	// (e.g. a transient DB error) should not take the whole service down,
	// only skip that round — see PollFleetHealth's own doc comment for the
	// per-dev-server error handling this relies on.
	go func() {
		const fleetHealthPollInterval = 30 * time.Second
		// Poll once immediately on startup — otherwise a freshly-started
		// service (or one that just came back up) leaves every dev server
		// unreachable-by-default in fleet_health for a full interval before
		// its first real sample lands.
		if err := pollFleetHealthUC.Execute(ctx); err != nil {
			logger.WarnContext(ctx, "fleet health poll failed", slog.Any("error", err))
		}
		ticker := time.NewTicker(fleetHealthPollInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := pollFleetHealthUC.Execute(ctx); err != nil {
					logger.WarnContext(ctx, "fleet health poll failed", slog.Any("error", err))
				}
			}
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

	// Wait for the outbox relay goroutine (if started) to observe ctx
	// cancellation and return, so it doesn't outlive the rest of the
	// server on shutdown — same pattern usage-service/notification-service's
	// own main.go use for their background loops.
	outboxRelayWG.Wait()

	return nil
}
