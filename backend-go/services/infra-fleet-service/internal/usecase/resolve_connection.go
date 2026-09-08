package usecase

import (
	"context"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/common/tenant"
	"github.com/stablyai/orca-go/services/infra-fleet-service/internal/domain"
)

// ResolveConnectionOutput is the resolved dispatch record: whether a dev
// server owns the given connectionId (Connected) and, if so, which one, plus
// the per-connection metadata (RepoPath, WorktreeID) callers like
// git-gateway-service's RelayExecutor need alongside DevServer.
type ResolveConnectionOutput struct {
	Connected bool
	DevServer domain.DevServer
	RepoPath  string
	// ConnectionID is the resolved infra.connections.id — the value Relay's
	// RelayInput.ConnectionID expects. Populated regardless of which
	// ResolveConnectionInput key resolved this row (TASK-025), so a
	// dev-server- or worktree-keyed caller has a valid Relay connection id
	// without conflating it with DevServer.ID, a different id space.
	ConnectionID string
	WorktreeID   string
	// HiddenTargetID (TASK-BE-EVM-018, BE-SOL-EVM-004 §4/§6c) is set ONLY
	// when WorktreeID is attached (ephemeralVm.attachWorkspace) to an
	// ephemeral VM runtime whose ConnectionType is "ssh" — by convention,
	// equal to that runtime's id. See Execute's doc comment for the lookup.
	HiddenTargetID string
}

// ResolveConnectionInput mirrors ResolveConnectionRequest 1:1 — exactly one
// of ConnectionID/DevServerID/WorktreeID is expected to be set (see
// infrafleet.proto's ResolveConnectionRequest doc comment).
type ResolveConnectionInput struct {
	ConnectionID string
	DevServerID  string
	WorktreeID   string
}

// ResolveConnection is THE core coordination/execution dispatch primitive of
// this service — see specs/backend-go/services/infra-fleet-service.md §7.
// git-gateway-service calls this on every git.* dispatch to decide
// local-exec vs. relay; project-service calls it to validate a dev-server
// binding; any connectionId-bound feature in the system reduces to this call.
//
// runtimes (TASK-BE-EVM-018, BE-SOL-EVM-004 §6c — closes TASK-BE-EVM-015's
// gap #1) is optional/nil-safe, mirroring AgentOutboundSshProvisioner.records'
// convention: a failed or skipped HiddenTargetID lookup must never block
// the connection resolution that matters to every other caller of this
// usecase. See Execute's HiddenTargetID population for the lookup itself.
type ResolveConnection struct {
	resolver ConnectionResolver
	runtimes EphemeralVmRuntimeRepository
}

func NewResolveConnection(resolver ConnectionResolver, runtimes EphemeralVmRuntimeRepository) *ResolveConnection {
	return &ResolveConnection{resolver: resolver, runtimes: runtimes}
}

func (uc *ResolveConnection) Execute(ctx context.Context, in ResolveConnectionInput) (ResolveConnectionOutput, error) {
	tenantID, err := tenant.RequireTenantID(ctx)
	if err != nil {
		return ResolveConnectionOutput{}, apperrors.New(apperrors.KindUnauthenticated, "INFRA_NO_TENANT", "no tenant in request context", err)
	}

	var (
		connected bool
		devServer domain.DevServer
		conn      domain.Connection
	)
	switch {
	case in.DevServerID != "":
		connected, devServer, conn, err = uc.resolver.ResolveConnectionByDevServer(ctx, tenantID, in.DevServerID)
	case in.WorktreeID != "":
		connected, devServer, conn, err = uc.resolver.ResolveConnectionByWorktree(ctx, tenantID, in.WorktreeID)
	case in.ConnectionID == "":
		// No key at all is not an error — it's the caller's own signal
		// that there's nothing to resolve (a connectionless, local-only
		// worktree or session). Short-circuit before the repository
		// round-trip.
		return ResolveConnectionOutput{Connected: false}, nil
	default:
		connected, devServer, conn, err = uc.resolver.ResolveConnection(ctx, tenantID, in.ConnectionID)
	}
	if err != nil {
		return ResolveConnectionOutput{}, apperrors.New(apperrors.KindInternal, "INFRA_RESOLVE_FAILED", "failed to resolve connection", err)
	}
	return ResolveConnectionOutput{
		Connected: connected, DevServer: devServer, ConnectionID: conn.ID, RepoPath: conn.RepoPath, WorktreeID: conn.WorktreeID,
		HiddenTargetID: uc.resolveHiddenTargetID(ctx, tenantID, conn.WorktreeID),
	}, nil
}

// resolveHiddenTargetID (TASK-BE-EVM-018, BE-SOL-EVM-004 §4/§6c) answers
// "is worktreeID currently attached (ephemeralVm.attachWorkspace) to an
// ssh-type ephemeral VM runtime" — worktreeID and an ephemeral VM's
// workspaceID are THE SAME id space in this codebase (confirmed by reading
// api-gateway's wscompat/channels_ephemeral_vm.go:
// resolveConnectionIDForWorktree is called with in.WorkspaceID and, in
// turn, sends it as ResolveConnectionRequest.WorktreeId — not a guess).
// runtimes==nil or "not found"/any lookup error are both the ordinary
// "no hidden target" case for the vast majority of connections — never
// escalated to an error, matching this whole field's orthogonal,
// best-effort nature (BE-SOL-EVM-004 §4 decision 3: ResolveConnection's
// dev_server target is unaffected either way).
func (uc *ResolveConnection) resolveHiddenTargetID(ctx context.Context, tenantID, worktreeID string) string {
	if uc.runtimes == nil || worktreeID == "" {
		return ""
	}
	rt, err := uc.runtimes.GetByWorkspaceID(ctx, tenantID, worktreeID)
	if err != nil || rt.ConnectionType != "ssh" {
		return ""
	}
	// Convention: hiddenTargetID == runtimeID (BE-SOL-EVM-004 §4), same as
	// DialHiddenSshTarget's fallback.
	return rt.ID
}
