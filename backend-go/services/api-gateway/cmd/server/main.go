// Command server is api-gateway's composition root — the only place
// allowed to know about every layer at once, per
// specs/backend-go/architecture/03-clean-architecture-guidelines.md.
//
// Unlike every other service, api-gateway runs no gRPC server of its own:
// per api-gateway.md §1/§7, it is a pure gRPC CLIENT to all 16 other
// services, never a downstream dependency of any of them ("It is called by
// frontend... mobile... and CLI clients... No internal service calls
// api-gateway"). Exposing a trivial gRPC health service here would add a
// listener nothing in the system is designed to call — the HTTP
// /healthz+/readyz server below is this service's only health surface,
// same convention every other service uses (common/health).
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"google.golang.org/grpc"
	"google.golang.org/grpc/connectivity"

	"github.com/stablyai/orca-go/common/eventbus"
	"github.com/stablyai/orca-go/common/health"
	"github.com/stablyai/orca-go/common/logging"
	"github.com/stablyai/orca-go/common/tracing"

	svcconfig "github.com/stablyai/orca-go/services/api-gateway/internal/config"
	"github.com/stablyai/orca-go/services/api-gateway/internal/domain"
	"github.com/stablyai/orca-go/services/api-gateway/internal/usecase"

	"github.com/stablyai/orca-go/services/api-gateway/internal/adapter/authclient"
	gatewaygrpc "github.com/stablyai/orca-go/services/api-gateway/internal/adapter/grpc"
	"github.com/stablyai/orca-go/services/api-gateway/internal/adapter/httpgateway"
	"github.com/stablyai/orca-go/services/api-gateway/internal/adapter/wsbridge"
	"github.com/stablyai/orca-go/services/api-gateway/internal/adapter/wscompat"

	aiproviderv1 "github.com/stablyai/orca-go/proto/gen/go/orca/aiprovider/v1"
	annotationv1 "github.com/stablyai/orca-go/proto/gen/go/orca/annotation/v1"
	authv1 "github.com/stablyai/orca-go/proto/gen/go/orca/auth/v1"
	automationv1 "github.com/stablyai/orca-go/proto/gen/go/orca/automation/v1"
	gitgatewayv1 "github.com/stablyai/orca-go/proto/gen/go/orca/gitgateway/v1"
	infrafleetv1 "github.com/stablyai/orca-go/proto/gen/go/orca/infrafleet/v1"
	issuetrackingv1 "github.com/stablyai/orca-go/proto/gen/go/orca/issuetracking/v1"
	notificationv1 "github.com/stablyai/orca-go/proto/gen/go/orca/notification/v1"
	orchestrationv1 "github.com/stablyai/orca-go/proto/gen/go/orca/orchestration/v1"
	projectv1 "github.com/stablyai/orca-go/proto/gen/go/orca/project/v1"
	scmintegrationv1 "github.com/stablyai/orca-go/proto/gen/go/orca/scmintegration/v1"
	taskv1 "github.com/stablyai/orca-go/proto/gen/go/orca/task/v1"
	tenantv1 "github.com/stablyai/orca-go/proto/gen/go/orca/tenant/v1"
	usagev1 "github.com/stablyai/orca-go/proto/gen/go/orca/usage/v1"
	workflowv1 "github.com/stablyai/orca-go/proto/gen/go/orca/workflow/v1"
)

// version is overridden at build time via -ldflags "-X main.version=...".
var version = "dev"

func main() {
	if err := run(); err != nil {
		slog.Error("api-gateway exited with error", slog.Any("error", err))
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

	// api-gateway's first NATS connection (TASK-BE-FFT-008) — used to
	// publish CR-FFT-002 TraceEvent spans onto the TRACE stream, and (from
	// TASK-BE-FFT-011) to subscribe to it for TracePanel's SSE bridge.
	// Deliberately NON-fatal on connect failure: trace data is
	// diagnostic/best-effort (CR-FFT-002's own doc comment), and
	// api-gateway is the single external HTTP/WS entry point — it must
	// never refuse to start (blocking ALL user traffic) just because an
	// optional tracing sink is unreachable, the same degrade posture every
	// other NATS-consuming service in this scaffold already uses.
	pub, cons, closeBus, err := eventbus.Connect(ctx, cfg.NATSURL)
	if err != nil {
		logger.WarnContext(ctx, "eventbus unavailable, trace events will not be published", slog.Any("error", err))
	} else {
		defer func() { _ = closeBus() }()
		if err := pub.EnsureStream(ctx, "TRACE", []string{"orca.*.trace.span"}); err != nil {
			logger.WarnContext(ctx, "failed to ensure TRACE jetstream stream", slog.Any("error", err))
		}
	}

	shutdownTracing, err := tracing.Init(ctx, cfg.ServiceName, cfg.OTLPEndpoint, tracing.WithTraceEventPublisher(pub))
	if err != nil {
		return fmt.Errorf("initializing tracing: %w", err)
	}
	defer func() { _ = shutdownTracing(context.Background()) }()

	// traceBroadcast fans TRACE stream events out to this replica's own
	// locally-connected /api/trace-stream SSE clients (TASK-BE-FFT-009/010).
	// Always constructed, even if NATS is unreachable — httpgateway.NewRouter
	// falls back to one too, but constructing it here lets the
	// SubscribeEphemeral goroutine below feed it real events whenever cons
	// is non-nil.
	traceBroadcast := httpgateway.NewTraceBroadcast()
	if cons != nil {
		go func() {
			// SubscribeEphemeral blocks until ctx is cancelled — run in its
			// own goroutine so it doesn't delay server startup. Best-effort:
			// an error here (e.g. TRACE stream missing) degrades to "no live
			// trace events" rather than crashing api-gateway — trace data is
			// diagnostic, not a startup-critical dependency (CR-FFT-002's
			// outbox rationale).
			if err := cons.SubscribeEphemeral(ctx, "TRACE", "orca.*.trace.span", traceEventHandler(traceBroadcast)); err != nil {
				logger.ErrorContext(ctx, "trace event subscription ended", slog.Any("error", err))
			}
		}()
	}

	// The two downstream services this scaffold really dials — see
	// README.md "what's really wired". grpc.NewClient doesn't block or
	// error on an unreachable target; connection health is surfaced via
	// /readyz below instead, so a downstream outage degrades readiness
	// rather than crashing the gateway at startup.
	usageConn, err := gatewaygrpc.Dial(cfg.UsageServiceAddr)
	if err != nil {
		return fmt.Errorf("dialing usage-service: %w", err)
	}
	defer func() { _ = usageConn.Close() }()
	usageClient := usagev1.NewUsageServiceClient(usageConn)

	notificationConn, err := gatewaygrpc.Dial(cfg.NotificationServiceAddr)
	if err != nil {
		return fmt.Errorf("dialing notification-service: %w", err)
	}
	defer func() { _ = notificationConn.Close() }()
	notificationClient := notificationv1.NewNotificationServiceClient(notificationConn)

	// Additional downstream connections for the wscompat legacy-frontend
	// compatibility layer (docs/execution-plan.md) — dialed the same
	// lazy/non-blocking way as usage-service/notification-service above;
	// an unreachable target degrades /readyz, doesn't crash startup.
	authConn, err := gatewaygrpc.Dial(cfg.OtherServiceAddrs["auth-service"])
	if err != nil {
		return fmt.Errorf("dialing auth-service: %w", err)
	}
	defer func() { _ = authConn.Close() }()
	authClient := authv1.NewAuthServiceClient(authConn)

	annotationConn, err := gatewaygrpc.Dial(cfg.OtherServiceAddrs["annotation-service"])
	if err != nil {
		return fmt.Errorf("dialing annotation-service: %w", err)
	}
	defer func() { _ = annotationConn.Close() }()
	annotationClient := annotationv1.NewAnnotationServiceClient(annotationConn)

	taskConn, err := gatewaygrpc.Dial(cfg.OtherServiceAddrs["task-service"])
	if err != nil {
		return fmt.Errorf("dialing task-service: %w", err)
	}
	defer func() { _ = taskConn.Close() }()
	taskClient := taskv1.NewTaskServiceClient(taskConn)

	gitConn, err := gatewaygrpc.Dial(cfg.OtherServiceAddrs["git-gateway-service"])
	if err != nil {
		return fmt.Errorf("dialing git-gateway-service: %w", err)
	}
	defer func() { _ = gitConn.Close() }()
	gitClient := gitgatewayv1.NewGitGatewayServiceClient(gitConn)

	automationConn, err := gatewaygrpc.Dial(cfg.OtherServiceAddrs["automation-service"])
	if err != nil {
		return fmt.Errorf("dialing automation-service: %w", err)
	}
	defer func() { _ = automationConn.Close() }()
	automationClient := automationv1.NewAutomationServiceClient(automationConn)

	infraFleetConn, err := gatewaygrpc.Dial(cfg.OtherServiceAddrs["infra-fleet-service"])
	if err != nil {
		return fmt.Errorf("dialing infra-fleet-service: %w", err)
	}
	defer func() { _ = infraFleetConn.Close() }()
	infraFleetClient := infrafleetv1.NewInfraFleetServiceClient(infraFleetConn)

	// Phase 5 (execution-plan.md) — the remaining downstream connections
	// this gateway's REST routes proxy to, dialed the same lazy/
	// non-blocking way as every connection above.
	tenantConn, err := gatewaygrpc.Dial(cfg.OtherServiceAddrs["tenant-service"])
	if err != nil {
		return fmt.Errorf("dialing tenant-service: %w", err)
	}
	defer func() { _ = tenantConn.Close() }()
	tenantClient := tenantv1.NewTenantServiceClient(tenantConn)

	projectConn, err := gatewaygrpc.Dial(cfg.OtherServiceAddrs["project-service"])
	if err != nil {
		return fmt.Errorf("dialing project-service: %w", err)
	}
	defer func() { _ = projectConn.Close() }()
	projectClient := projectv1.NewProjectServiceClient(projectConn)

	issueTrackingConn, err := gatewaygrpc.Dial(cfg.OtherServiceAddrs["issue-tracking-service"])
	if err != nil {
		return fmt.Errorf("dialing issue-tracking-service: %w", err)
	}
	defer func() { _ = issueTrackingConn.Close() }()
	issueTrackingClient := issuetrackingv1.NewIssueTrackingServiceClient(issueTrackingConn)

	aiProviderConn, err := gatewaygrpc.Dial(cfg.OtherServiceAddrs["ai-provider-service"])
	if err != nil {
		return fmt.Errorf("dialing ai-provider-service: %w", err)
	}
	defer func() { _ = aiProviderConn.Close() }()
	aiProviderClient := aiproviderv1.NewAiProviderServiceClient(aiProviderConn)

	orchestrationConn, err := gatewaygrpc.Dial(cfg.OtherServiceAddrs["orchestration-service"])
	if err != nil {
		return fmt.Errorf("dialing orchestration-service: %w", err)
	}
	defer func() { _ = orchestrationConn.Close() }()
	orchestrationClient := orchestrationv1.NewOrchestrationServiceClient(orchestrationConn)

	scmConn, err := gatewaygrpc.Dial(cfg.OtherServiceAddrs["scm-integration-service"])
	if err != nil {
		return fmt.Errorf("dialing scm-integration-service: %w", err)
	}
	defer func() { _ = scmConn.Close() }()
	scmClient := scmintegrationv1.NewScmIntegrationServiceClient(scmConn)

	workflowConn, err := gatewaygrpc.Dial(cfg.OtherServiceAddrs["workflow-service"])
	if err != nil {
		return fmt.Errorf("dialing workflow-service: %w", err)
	}
	defer func() { _ = workflowConn.Close() }()
	workflowClient := workflowv1.NewWorkflowServiceClient(workflowConn)

	// jwksClient resolves auth-service's public signing keys (cached, short
	// TTL — see authclient.JWKSClient) so authValidator can verify RS256
	// JWT signatures for real, instead of trusting unverified claims.
	jwksClient := authclient.NewJWKSClient(authClient)
	authValidator := usecase.NewAuthValidator(jwksClient)
	// Revocation set after construction (nil-tolerant field, not a
	// constructor param — see AuthValidator.Revocation's doc comment):
	// every bearer-JWT verify now also checks auth-service's real
	// IsServiceTokenRevoked RPC, short-TTL cached (CR-CLI-002/TASK-BE-CLI-005).
	authValidator.Revocation = authclient.NewRevocationClient(authClient)
	rateLimiter := usecase.NewRateLimiter(cfg.RateLimitRPS, cfg.RateLimitBurst)
	registry := domain.NewDefaultServiceRegistry()

	// sessionValidator resolves the browser's real orca_session cookie via
	// a REAL auth-service.ValidateSession call (a raw session token, never
	// a JWT — authValidator's JWT verification above can't handle it).
	// Shared by every consumer that needs cookie-first auth: httpgateway's
	// authMiddleware, wscompat (legacy transport), and wsbridge below.
	sessionValidator := authclient.New(authClient)

	// wsHandler opens one StreamNotifications gRPC call per WS connection,
	// scoped to that connection's own context (cancelled on WS close, see
	// wsbridge.Handler.ServeHTTP) — never a single shared stream fanned
	// out to multiple users, per api-gateway.md §3's "a connection is
	// never fanned out to more than one" rule. sessionValidator is tried
	// first (cookie-authenticated browser sessions have no bearer JWT to
	// present to authValidator), falling back to authValidator for
	// mobile/CLI bearer-JWT callers.
	// notificationStreamOpener is shared verbatim (via an explicit type
	// conversion, identical underlying func type) between wsbridge.New
	// below and wscompat.RegisterPushChannels — see NotificationStreamOpener's
	// doc comment: never construct a second stream-opening closure.
	notificationStreamOpener := wsbridge.StreamOpener(func(streamCtx context.Context, userID string) (notificationv1.NotificationService_StreamNotificationsClient, error) {
		streamCtx = gatewaygrpc.AttachIdentity(streamCtx, usecase.Identity{UserID: userID})
		return notificationClient.StreamNotifications(streamCtx, &notificationv1.StreamNotificationsRequest{UserId: userID})
	})
	wsHandler := wsbridge.New(logger, authValidator, sessionValidator, notificationStreamOpener)

	// wscompat: the legacy channel-based RPC transport the deployed
	// frontend/ actually speaks over /ws (see internal/adapter/wscompat's
	// package doc and docs/execution-plan.md's frontend-compatibility-layer
	// section). Session auth: cookie first via authclient.SessionValidator (a
	// REAL auth-service.ValidateSession call — the browser's orca_session
	// cookie holds a raw session token, never a JWT), falling back to
	// authValidator's bearer-JWT verification (CR-CLI-001/BE-CLI-SOL-001) for
	// non-browser callers (Orca CLI over ORCA_SERVER_URL) that present
	// Authorization: Bearer <jwt> instead of a cookie.
	wsCompatRegistry := wscompat.NewRegistry()
	wscompat.RegisterRealChannels(
		wsCompatRegistry, annotationClient, taskClient, gitClient, automationClient, infraFleetClient,
		tenantClient, projectClient, issueTrackingClient, orchestrationClient, scmClient, workflowClient,
		aiProviderClient, authClient,
		rateLimiter,
	)
	// RegisterPushChannels wires the StreamHandler-backed (push-capable)
	// channels — a separate registration mechanism from RegisterRealChannels'
	// request/response ChannelHandlers, see channels_push.go's doc comment.
	clientEventBus := wscompat.NewClientEventBus()
	wscompat.RegisterPushChannels(wsCompatRegistry, wscompat.NotificationStreamOpener(notificationStreamOpener), clientEventBus)
	// clientState.*/workspaceSession.* (CR-STORAGE-001/003/004a,b) — same
	// "separate call, not folded into RegisterRealChannels" pattern as
	// RegisterPushChannels above, so this addition doesn't collide with
	// other parallel edits to RegisterRealChannels's own signature.
	wscompat.RegisterClientStateChannels(wsCompatRegistry, tenantClient)
	wsCompatHandler := wscompat.New(logger, sessionValidator, authValidator, wsCompatRegistry)

	// agentProxyHandler raw-proxies the Dev Server Agent's /agent (WS) and
	// /api/agent-token (HTTP) traffic straight to infra-fleet-service — see
	// httpgateway.NewAgentProxyHandler's doc comment for why this is a
	// proxy rather than a gRPC translation like every other route here.
	// Left nil (routes not mounted) when unconfigured, same degrade-not-
	// panic shape as every optional downstream client above.
	var agentProxyHandler http.Handler
	if cfg.InfraFleetHTTPAddr != "" {
		agentProxyHandler = httpgateway.NewAgentProxyHandler(cfg.InfraFleetHTTPAddr)
	}

	router := httpgateway.NewRouter(httpgateway.Deps{
		Logger:          logger,
		Registry:        registry,
		AuthValidator:   authValidator,
		CookieValidator: sessionValidator,
		RateLimiter:     rateLimiter,
		UsageClient:     usageClient,
		AuthClient:      authClient,
		SsoConfig: httpgateway.SsoRouteConfig{
			PublicBaseURL:  cfg.PublicBaseURL,
			AuthMode:       cfg.AuthMode,
			GithubClientID: cfg.SsoGithubClientID,
			GoogleClientID: cfg.SsoGoogleClientID,
			OidcClientID:   cfg.SsoOidcClientID,
		},
		AnnotationClient:    annotationClient,
		TaskClient:          taskClient,
		GitGatewayClient:    gitClient,
		AutomationClient:    automationClient,
		InfraFleetClient:    infraFleetClient,
		NotificationClient:  notificationClient,
		TenantClient:        tenantClient,
		ProjectClient:       projectClient,
		IssueTrackingClient: issueTrackingClient,
		AIProviderClient:    aiProviderClient,
		OrchestrationClient: orchestrationClient,
		SCMClient:           scmClient,
		WorkflowClient:      workflowClient,
		WSHandler:           wsHandler.ServeHTTP,
		WSCompatHandler:     wsCompatHandler.ServeHTTP,
		AgentProxyHandler:   agentProxyHandler,
		TraceBroadcast:      traceBroadcast,
	})

	healthSrv := health.New()
	healthSrv.Register("usage-service", grpcConnHealthCheck(usageConn))
	healthSrv.Register("notification-service", grpcConnHealthCheck(notificationConn))
	healthSrv.Register("auth-service", grpcConnHealthCheck(authConn))
	healthSrv.Register("annotation-service", grpcConnHealthCheck(annotationConn))
	healthSrv.Register("task-service", grpcConnHealthCheck(taskConn))
	healthSrv.Register("git-gateway-service", grpcConnHealthCheck(gitConn))
	healthSrv.Register("automation-service", grpcConnHealthCheck(automationConn))
	healthSrv.Register("infra-fleet-service", grpcConnHealthCheck(infraFleetConn))
	healthSrv.Register("tenant-service", grpcConnHealthCheck(tenantConn))
	healthSrv.Register("project-service", grpcConnHealthCheck(projectConn))
	healthSrv.Register("issue-tracking-service", grpcConnHealthCheck(issueTrackingConn))
	healthSrv.Register("ai-provider-service", grpcConnHealthCheck(aiProviderConn))
	healthSrv.Register("orchestration-service", grpcConnHealthCheck(orchestrationConn))
	healthSrv.Register("scm-integration-service", grpcConnHealthCheck(scmConn))
	healthSrv.Register("workflow-service", grpcConnHealthCheck(workflowConn))

	// otelhttp gives every /api/* request its trace's root span — health
	// checks below stay unwrapped so they never depend on OTel exporter
	// health (TASK-BE-FFT-004).
	publicHandler := otelhttp.NewHandler(router, "api-gateway")

	publicServer := &http.Server{
		Addr:    fmt.Sprintf(":%d", cfg.PublicPort),
		Handler: publicHandler,
	}
	healthServer := &http.Server{
		Addr:    fmt.Sprintf(":%d", cfg.HTTPPort),
		Handler: healthSrv.Handler(),
	}

	errCh := make(chan error, 2)

	go func() {
		logger.Info("api-gateway public REST/WS edge listening", slog.Int("port", cfg.PublicPort))
		if err := publicServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- fmt.Errorf("public http server: %w", err)
		}
	}()

	go func() {
		logger.Info("api-gateway http (health) listening", slog.Int("port", cfg.HTTPPort))
		if err := healthServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- fmt.Errorf("health http server: %w", err)
		}
	}()

	select {
	case <-ctx.Done():
		logger.Info("shutdown signal received, draining in-flight requests")
	case err := <-errCh:
		return err
	}

	// Graceful shutdown: stop accepting new connections and let in-flight
	// requests (and open WS bridges, via wsbridge's context cancellation
	// on server shutdown) drain within the grace period, matching
	// standards/production-readiness-checklist.md.
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = publicServer.Shutdown(shutdownCtx)
	_ = healthServer.Shutdown(shutdownCtx)

	return nil
}

// traceEventHandler returns the eventbus.Handler passed to
// cons.SubscribeEphemeral (TASK-BE-FFT-011): each TRACE-stream event's
// already-JSON-encoded F40 TraceEvent Payload (TASK-BE-FFT-007) is
// forwarded straight into broadcast for /api/trace-stream's SSE clients.
// Extracted out of run() so this glue is unit-testable without a real NATS
// connection — run() itself dials 15+ live gRPC services and blocks on a
// shutdown signal, so (matching every other service's main.go in this
// codebase) it has no direct test.
func traceEventHandler(broadcast *httpgateway.TraceBroadcast) eventbus.Handler {
	return func(_ context.Context, event eventbus.Event) error {
		broadcast.Publish(event.Payload)
		return nil
	}
}

// grpcConnHealthCheck reports readiness from the ClientConn's connectivity
// state — not a full RPC round trip, just "is this connection not
// currently failing", cheap enough to run on every /readyz poll.
func grpcConnHealthCheck(conn *grpc.ClientConn) health.Checker {
	return func() error {
		state := conn.GetState()
		if state == connectivity.TransientFailure || state == connectivity.Shutdown {
			return fmt.Errorf("connection state: %s", state)
		}
		return nil
	}
}
