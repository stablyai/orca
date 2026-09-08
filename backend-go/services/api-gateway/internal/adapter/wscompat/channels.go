// Channel handlers with REAL backend-go logic behind them — every other
// channel the frontend can call falls through to registry.go's
// notImplementedHandler. See docs/execution-plan.md's frontend-compatibility
// coverage table for the full list of what's wired here vs. not.
//
// Arg-shape caveat: the invoke envelope's `args` is a generic JSON array
// (rpc-client.ts's `invoke(channel, ...args)` spreads whatever the call
// site passed). specs/frontend/api/rpc-catalog.md documents method names
// and call sites but not param shapes. Every handler below decodes args[0]
// as a single JSON object with the field names its proto request expects —
// a reasonable, common convention, but NOT verified against every real
// frontend call site's actual argument marshaling. Treat as best-effort;
// verify against the actual call site before depending on a specific
// channel in production.
//
// Channel count: 13 wired for real as of the devServer.*/fleet.* pass —
// annotation.{create,list,update,delete} (4), task.{create,get} (2),
// git.{status,diff} (2), automation.runNow (1), preflight.check (1),
// devServer.{list,add} (2), fleet.health.checkAll (1).
// (Stale even at the time of writing relative to the real registered set —
// this comment predates most of registerTenantProjectChannels'/this
// package's other groups' own additions and was never updated alongside
// them. Latest addition, for the record: orcaProjects.{list,
// linkSourceProject,unlinkSourceProject,getProjectData} (4) —
// channels_orca_project_sharing.go, closing the "Linked Projects" gap
// reported live on b15.openledger.vn.)
package wscompat

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	aiproviderv1 "github.com/stablyai/orca-go/proto/gen/go/orca/aiprovider/v1"
	annotationv1 "github.com/stablyai/orca-go/proto/gen/go/orca/annotation/v1"
	authv1 "github.com/stablyai/orca-go/proto/gen/go/orca/auth/v1"
	automationv1 "github.com/stablyai/orca-go/proto/gen/go/orca/automation/v1"
	gitgatewayv1 "github.com/stablyai/orca-go/proto/gen/go/orca/gitgateway/v1"
	infrafleetv1 "github.com/stablyai/orca-go/proto/gen/go/orca/infrafleet/v1"
	issuetrackingv1 "github.com/stablyai/orca-go/proto/gen/go/orca/issuetracking/v1"
	orchestrationv1 "github.com/stablyai/orca-go/proto/gen/go/orca/orchestration/v1"
	projectv1 "github.com/stablyai/orca-go/proto/gen/go/orca/project/v1"
	scmintegrationv1 "github.com/stablyai/orca-go/proto/gen/go/orca/scmintegration/v1"
	taskv1 "github.com/stablyai/orca-go/proto/gen/go/orca/task/v1"
	tenantv1 "github.com/stablyai/orca-go/proto/gen/go/orca/tenant/v1"
	workflowv1 "github.com/stablyai/orca-go/proto/gen/go/orca/workflow/v1"

	gatewaygrpc "github.com/stablyai/orca-go/services/api-gateway/internal/adapter/grpc"
	"github.com/stablyai/orca-go/services/api-gateway/internal/usecase"
)

// rateLimitReader is a minimal read interface over usecase.RateLimiter so
// this file stays testable without importing the full concrete struct.
// Satisfied by *usecase.RateLimiter after TASK-003 adds RPS()/Burst().
type rateLimitReader interface {
	RPS() float64
	Burst() int
}

// rateLimitInfo is the wire shape apiGateway.rateLimits.get returns.
type rateLimitInfo struct {
	RequestsPerSecond float64 `json:"requestsPerSecond"`
	Burst             int     `json:"burst"`
}

// rateLimitRuntimeTargetView mirrors frontend/src/shared/rate-limit-types.ts's
// RateLimitRuntimeTarget.
type rateLimitRuntimeTargetView struct {
	Runtime   string  `json:"runtime"` // "host" | "wsl"
	WSLDistro *string `json:"wslDistro"`
}

// rateLimitStateView is the wire shape rateLimits.get returns — mirrors
// frontend/src/shared/rate-limit-types.ts's RateLimitState field-for-field.
// Every provider is nil (not merely absent) since backend-go tracks no
// AI-provider usage yet — see registerRateLimitChannels's doc comment.
type rateLimitStateView struct {
	Claude                  any                        `json:"claude"`
	Codex                   any                        `json:"codex"`
	Gemini                  any                        `json:"gemini"`
	OpencodeGo              any                        `json:"opencodeGo"`
	Kimi                    any                        `json:"kimi"`
	Antigravity             any                        `json:"antigravity"`
	Minimax                 any                        `json:"minimax"`
	Grok                    any                        `json:"grok"`
	MinimaxCookieConfigured bool                       `json:"minimaxCookieConfigured"`
	GrokAuthConfigured      bool                       `json:"grokAuthConfigured"`
	ClaudeTarget            rateLimitRuntimeTargetView `json:"claudeTarget"`
	CodexTarget             rateLimitRuntimeTargetView `json:"codexTarget"`
	InactiveClaudeAccounts  []any                      `json:"inactiveClaudeAccounts"`
	InactiveCodexAccounts   []any                      `json:"inactiveCodexAccounts"`
}

// rpcTimeout is the per-RPC deadline applied to each outbound gRPC call inside
// a channel handler. Shorter than handler.go's invokeTimeout (25s) so a slow
// or unreachable downstream service fails fast with a meaningful error message
// rather than occupying the full dispatch window.
//
// Invariant: rpcTimeout (8s) < invokeTimeout (25s) — verified by
// TestRPCTimeoutConstant_ShorterThanInvokeTimeout in channels_test.go.
const rpcTimeout = 8 * time.Second

// RegisterRealChannels wires every channel this pass gives real backend-go
// implementations to. Called once from main.go's composition root with the
// gRPC clients already dialed there.
func RegisterRealChannels(
	r *Registry,
	annotationClient annotationv1.AnnotationServiceClient,
	taskClient taskv1.TaskServiceClient,
	gitClient gitgatewayv1.GitGatewayServiceClient,
	automationClient automationv1.AutomationServiceClient,
	infraFleetClient infrafleetv1.InfraFleetServiceClient,
	tenantClient tenantv1.TenantServiceClient,
	projectClient projectv1.ProjectServiceClient,
	issueTrackingClient issuetrackingv1.IssueTrackingServiceClient,
	orchestrationClient orchestrationv1.OrchestrationServiceClient,
	scmClient scmintegrationv1.ScmIntegrationServiceClient,
	workflowClient workflowv1.WorkflowServiceClient,
	aiProviderClient aiproviderv1.AiProviderServiceClient,
	authClient authv1.AuthServiceClient,
	rateLimits rateLimitReader,
) {
	registerAnnotationChannels(r, annotationClient)
	registerTaskChannels(r, taskClient)
	registerGitChannels(r, gitClient)
	registerAutomationChannels(r, automationClient)
	registerPreflightChannels(r)
	registerDevServerChannels(r, infraFleetClient)
	registerDevServerAccessControlChannels(r, infraFleetClient, tenantClient)
	registerFleetChannels(r, infraFleetClient)
	registerCliChannels(r, infraFleetClient)
	registerInfraFleetChannels(r, infraFleetClient)
	registerCrashReportChannels(r)
	registerRateLimitChannels(r, rateLimits)
	registerOnboardingChannels(r, infraFleetClient, tenantClient)
	registerStarNagChannels(r, tenantClient)
	registerStarNagGitHubChannels(r, tenantClient)
	registerTelemetryChannels(r)

	// Final integration pass — every group below was implemented as a
	// standalone channels_*.go file (channels.go itself deliberately
	// untouched by that work, per this batch's shared-file-avoidance
	// convention) and is wired in here in one place rather than at each
	// group's own call site, per each file's own "wire this from
	// RegisterRealChannels" doc comment. See each file's package/function
	// doc comment for which TASK-* IDs it covers.
	registerAccountsChannels(r, infraFleetClient)
	registerAiProviderChannels(r, aiProviderClient)
	registerCredentialsChannels(r, scmClient, issueTrackingClient)
	registerIssueTrackingOrchestrationChannels(r, issueTrackingClient, orchestrationClient, infraFleetClient)
	registerRepoSshStatusWorkspaceChannels(r, projectClient, gitClient, infraFleetClient)
	registerSCMChannels(r, scmClient, gitClient)
	registerBrowserChannels(r, infraFleetClient)
	registerEphemeralVmChannels(r, gitClient, projectClient, infraFleetClient)
	registerFilesBrowseServerDirChannel(r, infraFleetClient)
	registerBrowserScreencastChannel(r, infraFleetClient)
	registerBrowserProfileChannels(r, infraFleetClient)
	// registerGitDeepChannels must be called after registerGitChannels:
	// both register "git.diff", and only the deep version threads FilePath
	// through (TASK-228's per-file diff fix) — Registry.Register overwrites
	// on a repeated key, so call order decides which handler wins.
	registerGitDeepChannels(r, gitClient)
	registerFilesChannels(r, gitClient)
	registerAutomationTaskChannels(r, automationClient, taskClient)
	registerWorktreeChannels(r, gitClient, projectClient)
	registerWorkspaceChannels(r, gitClient, projectClient)
	registerSessionTabsChannels(r, infraFleetClient)
	registerEmulatorFolderWorkspaceHostChannels(r, projectClient, infraFleetClient)
	registerTeamChannels(r, tenantClient)
	registerTerminalChannels(r, infraFleetClient)
	registerTenantProjectChannels(r, tenantClient, projectClient)
	registerOrcaProjectSharingChannels(r, projectClient)
	registerWorkflowChannels(r, workflowClient)
	registerAdminUserChannels(r, authClient, tenantClient)
	registerAuthDirectoryChannels(r, authClient)
}

// ── annotation.* ────────────────────────────────────────────────────────

type annotationAnchorArg struct {
	RepoID   string `json:"repoId"`
	FilePath string `json:"filePath"`
	Line     int32  `json:"line"`
	Ref      string `json:"ref"`
}

func registerAnnotationChannels(r *Registry, client annotationv1.AnnotationServiceClient) {
	r.Register("annotation.create", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type createArgs struct {
			Anchor    annotationAnchorArg `json:"anchor"`
			Content   string              `json:"content"`
			RequestID string              `json:"requestId"`
		}
		in, err := decodeArg[createArgs](args, 0)
		if err != nil {
			return nil, err
		}
		resp, err := client.CreateAnnotation(ctx, &annotationv1.CreateAnnotationRequest{
			Anchor: &annotationv1.Anchor{
				RepoId:   in.Anchor.RepoID,
				FilePath: in.Anchor.FilePath,
				Line:     in.Anchor.Line,
				Ref:      in.Anchor.Ref,
			},
			Content:   in.Content,
			RequestId: in.RequestID,
		})
		if err != nil {
			return nil, err
		}
		return resp.GetAnnotation(), nil
	})

	r.Register("annotation.list", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type listArgs struct {
			RepoID    string `json:"repoId"`
			FilePath  string `json:"filePath"`
			PageToken string `json:"pageToken"`
			PageSize  int32  `json:"pageSize"`
		}
		in, err := decodeArg[listArgs](args, 0)
		if err != nil {
			return nil, err
		}
		resp, err := client.ListAnnotations(ctx, &annotationv1.ListAnnotationsRequest{
			RepoId:    in.RepoID,
			FilePath:  in.FilePath,
			PageToken: in.PageToken,
			PageSize:  in.PageSize,
		})
		if err != nil {
			return nil, err
		}
		return resp, nil
	})

	r.Register("annotation.update", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type updateArgs struct {
			ID       string `json:"id"`
			Content  string `json:"content"`
			Resolved bool   `json:"resolved"`
		}
		in, err := decodeArg[updateArgs](args, 0)
		if err != nil {
			return nil, err
		}
		resp, err := client.UpdateAnnotation(ctx, &annotationv1.UpdateAnnotationRequest{
			Id: in.ID, Content: in.Content, Resolved: in.Resolved,
		})
		if err != nil {
			return nil, err
		}
		return resp.GetAnnotation(), nil
	})

	r.Register("annotation.delete", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type deleteArgs struct {
			ID string `json:"id"`
		}
		in, err := decodeArg[deleteArgs](args, 0)
		if err != nil {
			return nil, err
		}
		if _, err := client.DeleteAnnotation(ctx, &annotationv1.DeleteAnnotationRequest{Id: in.ID}); err != nil {
			return nil, err
		}
		return map[string]bool{"ok": true}, nil
	})
}

// ── task.* (subset: create/get — the DAG/grant channels backing
// task-service's real BFS/cycle-detection logic; execute/AI-decompose are
// not wired since they depend on infra-fleet-service/orchestration-service,
// still stubs — see task-service's own README) ─────────────────────────

func registerTaskChannels(r *Registry, client taskv1.TaskServiceClient) {
	r.Register("task.create", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type createArgs struct {
			Title    string `json:"title"`
			ParentID string `json:"parentId"`
		}
		in, err := decodeArg[createArgs](args, 0)
		if err != nil {
			return nil, err
		}
		resp, err := client.CreateTask(ctx, &taskv1.CreateTaskRequest{
			TenantId: id.TenantID, Title: in.Title, ParentId: in.ParentID,
		})
		if err != nil {
			return nil, err
		}
		return resp.GetTask(), nil
	})

	r.Register("task.get", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type getArgs struct {
			ID string `json:"id"`
		}
		in, err := decodeArg[getArgs](args, 0)
		if err != nil {
			return nil, err
		}
		resp, err := client.GetTask(ctx, &taskv1.GetTaskRequest{Id: in.ID})
		if err != nil {
			return nil, err
		}
		return resp.GetTask(), nil
	})
}

// ── git.* (subset: status/diff — the two ops git-gateway-service
// implements for real against the local git binary; commit/push/pull relay
// to the Dev Server Agent, still a stub) ────────────────────────────────

func registerGitChannels(r *Registry, client gitgatewayv1.GitGatewayServiceClient) {
	r.Register("git.status", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		// Every real caller (WorkspaceContext.tsx, useGit.ts, use-code-review.ts,
		// runtime-git-client.ts, web-preload-api.ts's status) sends the
		// selector under "worktree" (toRuntimeWorktreeSelector, "id:"-prefixed)
		// — never "worktreeId". Decoding the wrong key silently left
		// WorktreeId empty on every call, tripping git-gateway-service's
		// GITGATEWAY_MISSING_WORKTREE_ID guard 100% of the time (found live,
		// repeating in git-gateway-service's logs).
		type statusArgs struct {
			Worktree string `json:"worktree"`
		}
		in, err := decodeArg[statusArgs](args, 0)
		if err != nil {
			return nil, err
		}
		resp, err := client.GetStatus(ctx, &gitgatewayv1.GetStatusRequest{WorktreeId: stripWorktreeSelectorPrefix(in.Worktree)})
		if err != nil {
			return nil, err
		}
		return resp, nil
	})

	r.Register("git.diff", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type diffArgs struct {
			WorktreeID string `json:"worktreeId"`
			Staged     bool   `json:"staged"`
		}
		in, err := decodeArg[diffArgs](args, 0)
		if err != nil {
			return nil, err
		}
		resp, err := client.GetDiff(ctx, &gitgatewayv1.GetDiffRequest{WorktreeId: in.WorktreeID, Staged: in.Staged})
		if err != nil {
			return nil, err
		}
		return resp, nil
	})
}

// ── automation.runNow (the one real cross-service call in this whole
// scaffold — see automation-service's README) ──────────────────────────

func registerAutomationChannels(r *Registry, client automationv1.AutomationServiceClient) {
	r.Register("automation.runNow", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type runNowArgs struct {
			AutomationID string `json:"automationId"`
			RequestID    string `json:"requestId"`
		}
		in, err := decodeArg[runNowArgs](args, 0)
		if err != nil {
			return nil, err
		}
		resp, err := client.RunNow(ctx, &automationv1.RunNowRequest{
			AutomationId: in.AutomationID, RequestId: in.RequestID,
		})
		if err != nil {
			return nil, err
		}
		return resp.GetRun(), nil
	})
}

// ── devServer.* / fleet.health.* (infra-fleet-service) ──────────────────
//
// Unlike every register*Channels above, these handlers MUST call
// gatewaygrpc.AttachIdentity before invoking the client: infra-fleet-service
// requires tenant metadata on the OUTBOUND gRPC context (it has no
// tenant_id request field to fall back on for List/Register — and even
// GetFleetHealthRequest's tenant_id field is ignored server-side, see the
// proto comment). Every other channel in this file calls its client with
// the bare inbound ctx and silently does NOT forward tenant metadata — do
// not copy that pattern here, it would make every call fail with
// INFRA_NO_TENANT.
//
// Field-shape gap: infra-fleet-service's DevServer message is
// {id, tenant_id, host, mode} only — none of the frontend's
// name/status/platform/arch/nodeVersion/lastConnectedAt/lastError/
// workspaceDir/addedAt/capabilities fields exist server-side yet. toDevServerView
// below fills the required-but-absent fields with honest placeholders
// (host doubles as display name; status is always "disconnected" since
// backend-go doesn't track live relay connection state; everything else
// is null/zero) rather than fabricating data. Same story in reverse for
// devServer.add: DevServerInput's name/sshTargetId/wsUrl have no matching
// proto fields beyond a single generic `host` string — devServerHost below
// picks the best available one, in order wsUrl > sshTargetId > name.
//
// devServer.connect/disconnect/remove/testConnection are deliberately NOT
// registered — infra-fleet-service has no backing RPC for any of them
// (no persisted connection lifecycle or delete endpoint exists yet). They
// fall through to notImplementedHandler like every other unregistered
// channel; this is a known gap, not an oversight.

// devServerView is the wire shape devServer.list/add return — mirrors
// frontend/src/shared/dev-server-types.ts's DevServer type field-for-field,
// including its required (non-optional) null-able fields, so a decoder on
// the frontend written against that type sees keys it expects even when
// this backend has nothing real to put in them yet.
type devServerView struct {
	ID              string   `json:"id"`
	Name            string   `json:"name"`
	ConnectionType  string   `json:"connectionType"`
	SSHTargetID     *string  `json:"sshTargetId,omitempty"`
	WSUrl           *string  `json:"wsUrl,omitempty"`
	Status          string   `json:"status"`
	Platform        *string  `json:"platform"`
	Arch            *string  `json:"arch"`
	NodeVersion     *string  `json:"nodeVersion"`
	LastConnectedAt *int64   `json:"lastConnectedAt"`
	LastError       *string  `json:"lastError"`
	WorkspaceDir    *string  `json:"workspaceDir"`
	AddedAt         int64    `json:"addedAt"`
	Capabilities    []string `json:"capabilities"`
	// ApprovalStatus/GroupID — CR-DS-006 Phase 2. Frontend field names
	// (approvalStatus, groupId) — NOT the same as this struct's own Go
	// field naming for the pre-existing "status" field (a different,
	// unrelated concept: live relay connection state, always
	// "disconnected" here per this view's own comment below).
	ApprovalStatus string `json:"approvalStatus"`
	GroupID        string `json:"groupId"`
	// HealthStatus is a THIRD, distinct "status" concept from this struct's
	// own Status (live relay connection state) and ApprovalStatus (admin
	// approval) — the coarse dev-server health/bootstrap state backend-go
	// now exposes (infrafleetv1.DevServer.health_status). "pending" | "healthy" |
	// "degraded" | "unhealthy". See
	// docs/backlog/BACKLOG-007-dev-server-bootstrap-status-proto-field.md.
	HealthStatus string `json:"healthStatus"`
}

// toDevServerView maps a proto DevServer (id/tenant_id/host/mode only) onto
// the frontend's richer DevServer shape — see this section's doc comment
// for which fields are real vs. placeholder.
func toDevServerView(ds *infrafleetv1.DevServer) devServerView {
	view := devServerView{
		ID:             ds.GetId(),
		Name:           ds.GetHost(), // no `name` field server-side — host doubles as display name
		ConnectionType: fromConnectionMode(ds.GetMode()),
		Status:         "disconnected", // overwritten by attachConnectionStatus wherever live status matters
		ApprovalStatus: ds.GetApprovalStatus(),
		GroupID:        ds.GetGroupId(),
		HealthStatus:   ds.GetHealthStatus(),
	}
	if host := ds.GetHost(); host != "" {
		view.WSUrl = &host
	}
	return view
}

// attachConnectionStatus overwrites view.Status with the dev server's REAL
// live-connection state via IsDevServerConnected — the live-bug fix for
// devServer.list/listForUser always reporting "disconnected" regardless of
// whether the agent actually has a live session (toDevServerView's
// placeholder never distinguished the two). Fails open to "disconnected"
// on any RPC error — a status check hiccup must never break the whole list.
// Used only where the caller actually renders/filters on live status
// (devServer.list/listForUser); the single-object mutation-response
// channels (approve/reject/assignGroup/add) are left as the honest
// placeholder since their callers don't use Status to decide anything.
func attachConnectionStatus(ctx context.Context, client infrafleetv1.InfraFleetServiceClient, view devServerView) devServerView {
	rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
	defer cancel()
	resp, err := client.IsDevServerConnected(rpcCtx, &infrafleetv1.IsDevServerConnectedRequest{DevServerId: view.ID})
	if err != nil {
		return view
	}
	if resp.GetConnected() {
		view.Status = "connected"
	} else {
		view.Status = "disconnected"
	}
	return view
}

// toConnectionMode maps frontend/src/shared/dev-server-types.ts's
// DevServerConnectionType string union onto the proto ConnectionMode enum.
func toConnectionMode(connectionType string) infrafleetv1.ConnectionMode {
	switch connectionType {
	case "relay-ssh":
		return infrafleetv1.ConnectionMode_CONNECTION_MODE_RELAY_SSH
	case "relay-websocket":
		return infrafleetv1.ConnectionMode_CONNECTION_MODE_RELAY_WEBSOCKET
	case "direct-websocket":
		return infrafleetv1.ConnectionMode_CONNECTION_MODE_DIRECT_WEBSOCKET
	default:
		return infrafleetv1.ConnectionMode_CONNECTION_MODE_UNSPECIFIED
	}
}

// fromConnectionMode is toConnectionMode's inverse, for devServer.list's
// response mapping.
func fromConnectionMode(mode infrafleetv1.ConnectionMode) string {
	switch mode {
	case infrafleetv1.ConnectionMode_CONNECTION_MODE_RELAY_SSH:
		return "relay-ssh"
	case infrafleetv1.ConnectionMode_CONNECTION_MODE_RELAY_WEBSOCKET:
		return "relay-websocket"
	case infrafleetv1.ConnectionMode_CONNECTION_MODE_DIRECT_WEBSOCKET:
		return "direct-websocket"
	default:
		return ""
	}
}

// devServerHost picks RegisterDevServerRequest's single generic `host`
// string out of DevServerInput's three more specific fields — wsUrl first
// (most literally a connection address), then sshTargetId, then name, since
// backend-go has no field to hold more than one of these at once.
func devServerHost(wsURL, sshTargetID, name string) string {
	switch {
	case wsURL != "":
		return wsURL
	case sshTargetID != "":
		return sshTargetID
	default:
		return name
	}
}

func registerDevServerChannels(r *Registry, client infrafleetv1.InfraFleetServiceClient) {
	r.Register("devServer.list", func(ctx context.Context, id Identity, _ []json.RawMessage) (any, error) {
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		// Per-RPC deadline: fail fast so the write-back (SOL-001 / TASK-001)
		// still has time to deliver the error to the frontend before invokeTimeout.
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		resp, err := client.ListDevServers(rpcCtx, &infrafleetv1.ListDevServersRequest{})
		if err != nil {
			return nil, err
		}
		views := make([]devServerView, 0, len(resp.GetDevServers()))
		for _, ds := range resp.GetDevServers() {
			views = append(views, attachConnectionStatus(ctx, client, toDevServerView(ds)))
		}
		return views, nil
	})

	r.Register("devServer.add", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type addArgs struct {
			Name           string `json:"name"`
			ConnectionType string `json:"connectionType"`
			SSHTargetID    string `json:"sshTargetId"`
			WSUrl          string `json:"wsUrl"`
		}
		in, err := decodeArg[addArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		// Per-RPC deadline (same reasoning as devServer.list above).
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		resp, err := client.RegisterDevServer(rpcCtx, &infrafleetv1.RegisterDevServerRequest{
			TenantId: id.TenantID,
			Host:     devServerHost(in.WSUrl, in.SSHTargetID, in.Name),
			Mode:     toConnectionMode(in.ConnectionType),
		})
		if err != nil {
			return nil, err
		}
		return toDevServerView(resp.GetDevServer()), nil
	})

	// devServer.listSshTargets: lets the "connect a dev server" UI (onboarding
	// DevServerStep.tsx) offer a picker of already-configured SSH targets for
	// connectionType relay-ssh, instead of a free-text target-id box. Reuses
	// the exact same InfraFleetServiceClient.ListSshTargets call
	// "ssh.listTargets" already wraps — this file only adds the response
	// envelope frontend/src/renderer/src/web/web-preload-api.ts's
	// listSshTargets() expects: `{ targets: [...] }`, not a bare array.
	//
	// Field gap: backend-go's SshTarget proto message only carries
	// id/host/user (Vault-cert auth, no key-file config) — frontend/src/
	// shared/ssh-types.ts's SshTarget additionally requires label/port/
	// username. label/port are synthesized here (not fabricated data —
	// `user@host` and the standard SSH port are reasonable, honest
	// defaults for a picker, not claims about the real target's config).
	r.Register("devServer.listSshTargets", func(ctx context.Context, id Identity, _ []json.RawMessage) (any, error) {
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		resp, err := client.ListSshTargets(rpcCtx, &infrafleetv1.ListSshTargetsRequest{})
		if err != nil {
			return nil, err
		}
		targets := make([]sshTargetPickerView, 0, len(resp.GetSshTargets()))
		for _, t := range resp.GetSshTargets() {
			targets = append(targets, sshTargetPickerView{
				ID:       t.GetId(),
				Label:    t.GetUser() + "@" + t.GetHost(),
				Host:     t.GetHost(),
				Port:     22,
				Username: t.GetUser(),
			})
		}
		return map[string]any{"targets": targets}, nil
	})

	// devServer.browseDir — the onboarding "Add a project" flow's folder
	// picker (Browse host / Clone from URL's parent folder / Create on
	// host's parent folder — all three ultimately render RemoteFileBrowser
	// with a devServerId) always failed live: this channel never existed at
	// all, so web-preload-api.ts's devServer.browseDir call always hit
	// Registry's generic "not yet implemented" error.
	//
	// Relays through RelayByDevServer, NOT ResolveConnection+Relay
	// (onboarding.detectAgents's pattern) — deliberately: ResolveConnection
	// answers "is there an infra.connections row for this dev server", a
	// DIFFERENT concept from "is the agent's session live" (see
	// usecase.RelayByDevServer's doc comment). A dev server has no
	// connections row until a repo/worktree is bound to it — exactly the
	// chicken-and-egg case browsing BEFORE picking a project hits. First
	// live bug found this way: a genuinely-connected, freshly-added dev
	// server always reported "not connected" here, and separately always
	// showed "disconnected" in the dev server list (toDevServerView's
	// Status was a hardcoded placeholder — see attachConnectionStatus, the
	// real fix for that half).
	//
	// Relays to the agent's own confirmed fs.readDir RPC
	// (specs/agent/api/agent-rpc-catalog-git-fs.md), mapping its
	// {entries:[{path,name,type,size?}],path} into the
	// {resolvedPath,entries:[{name,isDirectory,isSymlink}]} shape
	// web-preload-api.ts / RemoteFileBrowser already expect (same shape
	// desktop's own local files.browseServerDir returns).
	//
	// Home-directory resolution gap, honestly disclosed rather than faked:
	// fs.readDir does no `~` expansion (no shell involved, pure Node fs
	// calls) and no dev-server-agent RPC reports the remote user's home
	// directory today. An incoming "" or "~" therefore starts the browse at
	// "/" (always a valid absolute directory) instead of a guessed home —
	// the user can navigate from there. Revisit if/when the agent gains a
	// home-directory-reporting RPC.
	r.Register("devServer.browseDir", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type browseDirArgs struct {
			DevServerID string `json:"id"`
			Path        string `json:"path"`
		}
		in, err := decodeArg[browseDirArgs](args, 0)
		if err != nil {
			return nil, err
		}
		if in.DevServerID == "" {
			return nil, fmt.Errorf("DEVSERVER_BROWSE_NO_DEV_SERVER: id is required")
		}
		path := in.Path
		if path == "" || path == "~" {
			path = "/"
		}

		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID, Role: id.Role})
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()

		paramsJSON, err := json.Marshal(map[string]any{"path": path, "depth": 1})
		if err != nil {
			return nil, err
		}
		resp, err := client.RelayByDevServer(rpcCtx, &infrafleetv1.RelayByDevServerRequest{
			DevServerId: in.DevServerID,
			Method:      "fs.readDir",
			ParamsJson:  string(paramsJSON),
		})
		if err != nil {
			return nil, err
		}

		var relayResult struct {
			Path    string `json:"path"`
			Entries []struct {
				Name string `json:"name"`
				Type string `json:"type"`
			} `json:"entries"`
		}
		if raw := resp.GetResultJson(); raw != "" {
			if err := json.Unmarshal([]byte(raw), &relayResult); err != nil {
				return nil, fmt.Errorf("devServer.browseDir: decoding relay result: %w", err)
			}
		}
		entries := make([]devServerBrowseDirEntryView, 0, len(relayResult.Entries))
		for _, e := range relayResult.Entries {
			entries = append(entries, devServerBrowseDirEntryView{
				Name:        e.Name,
				IsDirectory: e.Type == "directory",
				// fs.readDir does not report symlink-ness — see this
				// channel's doc comment.
				IsSymlink: false,
			})
		}
		resolvedPath := relayResult.Path
		if resolvedPath == "" {
			resolvedPath = path
		}
		return devServerBrowseDirResultView{ResolvedPath: resolvedPath, Entries: entries}, nil
	})
}

// devServerBrowseDirEntryView/devServerBrowseDirResultView mirror
// web-preload-api.ts's devServer.browseDir return type
// ({resolvedPath, entries:[{name,isDirectory,isSymlink}]}) — see that
// channel's doc comment above.
type devServerBrowseDirEntryView struct {
	Name        string `json:"name"`
	IsDirectory bool   `json:"isDirectory"`
	IsSymlink   bool   `json:"isSymlink"`
}

type devServerBrowseDirResultView struct {
	ResolvedPath string                        `json:"resolvedPath"`
	Entries      []devServerBrowseDirEntryView `json:"entries"`
}

// sshTargetPickerView is the minimal subset of frontend/src/shared/
// ssh-types.ts's SshTarget that devServer.listSshTargets can honestly
// populate from backend-go's SshTarget proto message — see that channel's
// doc comment for which fields are synthesized and why.
type sshTargetPickerView struct {
	ID       string `json:"id"`
	Label    string `json:"label"`
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Username string `json:"username"`
}

// ── fleet.health.checkAll ─────────────────────────────────────────────────

// serverHealthView mirrors frontend/src/renderer/src/store/slices/ssh.ts's
// ServerHealthMetrics type. uptimeSeconds/relayVersion/nodeVersion have no
// equivalent on infra-fleet-service's DevServerHealth message — left as
// permanently-nil pointers (marshal to JSON null) rather than fabricated,
// per this file's package doc comment's best-effort/honesty convention.
type serverHealthView struct {
	ServerID         string  `json:"serverId"`
	LastCheckedAt    int64   `json:"lastCheckedAt"`
	IsReachable      bool    `json:"isReachable"`
	UptimeSeconds    *int64  `json:"uptimeSeconds"`
	RelayVersion     *string `json:"relayVersion"`
	NodeVersion      *string `json:"nodeVersion"`
	DiskUsagePercent float64 `json:"diskUsagePercent"`
	CPUUsagePercent  float64 `json:"cpuUsagePercent"`
	MemUsagePercent  float64 `json:"memUsagePercent"`
}

func registerFleetChannels(r *Registry, client infrafleetv1.InfraFleetServiceClient) {
	r.Register("fleet.health.checkAll", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type checkAllArgs struct {
			ServerIDs []string `json:"serverIds"`
		}
		in, err := decodeArg[checkAllArgs](args, 0)
		if err != nil {
			return nil, err
		}

		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		// Per-RPC deadline: GetFleetHealth involves active health checks to
		// dev servers which can be slow — 8s allows for reasonable network
		// latency while still failing before invokeTimeout.
		// TenantId on the request is ignored server-side (tenant always comes
		// from ctx metadata, per infrafleet.proto's comment) — set anyway for
		// readability/documentation at this call site.
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		resp, err := client.GetFleetHealth(rpcCtx, &infrafleetv1.GetFleetHealthRequest{TenantId: id.TenantID})
		if err != nil {
			return nil, err
		}

		// GetFleetHealth returns health for ALL of the tenant's dev servers,
		// not filtered by the requested serverIds (no such filter param
		// exists on the RPC) — filter client-side here to match what the
		// frontend actually asked for.
		wanted := make(map[string]bool, len(in.ServerIDs))
		for _, sid := range in.ServerIDs {
			wanted[sid] = true
		}

		now := time.Now().UnixMilli()
		views := make([]serverHealthView, 0, len(resp.GetStatuses()))
		for _, s := range resp.GetStatuses() {
			if !wanted[s.GetDevServerId()] {
				continue
			}
			views = append(views, serverHealthView{
				ServerID:         s.GetDevServerId(),
				LastCheckedAt:    now,
				IsReachable:      s.GetReachable(),
				DiskUsagePercent: s.GetDiskPercent(),
				CPUUsagePercent:  s.GetCpuPercent(),
				MemUsagePercent:  s.GetRamPercent(),
			})
		}
		return views, nil
	})
}

// ── preflight.check ──────────────────────────────────────────────────────
//
// Registered as a fast, LOCAL (no downstream call) response — see
// docs/execution-plan.md §7. This handler is intentionally local-only: if it is
// observed to time out in production after SOL-001 (TASK-001) and SOL-003
// (TASK-008) are applied, the cause is writeMu contention (BUG-004 Cause B) —
// look for "wscompat: writeMu contention detected" log entries on the same
// connection around the same timestamp.
//
// frontend/src/preload/api-types.ts's PreflightStatus asks about `gh`/`glab`
// CLI installed+authenticated state — that concept doesn't map onto
// backend-go's design: scm-integration-service is a direct OAuth API client,
// deliberately NOT a `gh`/`glab` CLI wrapper. Reporting installed:false/
// authenticated:false for both is the honest answer.
func registerPreflightChannels(r *Registry) {
	r.Register("preflight.check", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		return map[string]any{
			"git":  map[string]any{"installed": true}, // git-gateway-service's local executor requires the real git binary
			"gh":   map[string]any{"installed": false, "authenticated": false},
			"glab": map[string]any{"installed": false, "authenticated": false},
		}, nil
	})
}

// ── crashReports.* ──────────────────────────────────────────────────────────
//
// backend-go has no crash reporting service — this architecture uses structured
// gRPC error propagation (apperrors.ToGRPCStatus) and OpenTelemetry traces
// instead of a separate crash-report collection service. The frontend calls
// crashReports.getLatestPending on every bootstrap; returning null is the
// honest answer ("no pending crash report"), not a stub — there is genuinely
// nothing to report from backend-go's crash/panic path.
func registerCrashReportChannels(r *Registry) {
	r.Register("crashReports.getLatestPending", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		// null signals "no pending crash report" — matches the frontend's
		// crashReports.getLatestPending contract (nullable return).
		return nil, nil
	})
}

// ── apiGateway.rateLimits.* / rateLimits.* ──────────────────────────────────
//
// apiGateway.rateLimits.get exposes api-gateway's in-process per-tenant rate
// limiter configuration (RPS/burst) — not per-tenant counters (those are
// ephemeral per-replica state, not meaningful to expose externally).
//
// This does NOT own the "rateLimits.get" name: the frontend already has a
// long-standing, unrelated rateLimits.get RPC for AI-provider usage
// snapshots (frontend/src/renderer/src/runtime/runtime-rate-limits-client.ts,
// frontend/src/shared/rate-limit-types.ts's RateLimitState) — StatusBar
// destructures its per-provider fields on every render. An earlier pass
// registered this gateway-throttle feature under the bare "rateLimits.get"
// name without checking that (the doc comment even claimed a "RateLimitInfo"
// frontend type that never existed), silently shadowing it — StatusBar then
// crashed reading `.status` off the throttle shape's missing provider keys
// (undefined, not null — see status-bar-provider-visibility.ts's
// isProviderConfigured). Namespaced under apiGateway.* here so both can
// coexist; rateLimits.get below now answers the real contract.
func registerRateLimitChannels(r *Registry, rl rateLimitReader) {
	r.Register("apiGateway.rateLimits.get", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		return rateLimitInfo{
			RequestsPerSecond: rl.RPS(),
			Burst:             rl.Burst(),
		}, nil
	})

	// rateLimits.get: the real AI-provider-usage contract. backend-go has no
	// provider-usage tracking yet (that lived in the old TS backend's
	// backend/src/main/telemetry-sibling rate-limits module, never ported) —
	// every provider null / status absent is the honest "not tracked here"
	// answer, matching RateLimitState's shape field-for-field so StatusBar's
	// destructure sees real nulls instead of missing keys.
	r.Register("rateLimits.get", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		return rateLimitStateView{
			ClaudeTarget:           rateLimitRuntimeTargetView{Runtime: "host"},
			CodexTarget:            rateLimitRuntimeTargetView{Runtime: "host"},
			InactiveClaudeAccounts: []any{},
			InactiveCodexAccounts:  []any{},
		}, nil
	})
}
