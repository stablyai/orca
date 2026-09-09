package usecase

import (
	"context"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/common/tenant"
	"github.com/stablyai/orca-go/services/infra-fleet-service/internal/domain"
)

// StreamFileChangesInput mirrors the gRPC request's dual addressing —
// exactly one of ConnectionID/DevServerID is set, same convention as
// Relay/RelayByDevServer (see those types' doc comments for why both
// addressing modes exist; git-gateway-service's own RelayExecutor.relay
// already picks between them the same way for every other files.*/git.*
// method).
type StreamFileChangesInput struct {
	ConnectionID string
	DevServerID  string
	Path         string
}

// StreamFileChanges is BACKLOG-003's transport-level primitive: resolves
// either addressing mode to a domain.DevServer (mirroring Relay/
// RelayByDevServer's own resolution logic exactly, just streaming instead
// of unary) and subscribes to fs.changed notifications for Path via
// DevServerAgentClient.StreamFileChanges. git-gateway-service's
// WatchWorktreeFiles is the one caller — it resolves worktree_id ->
// repoPath/connectionId (or devServerId) before calling this, the same
// resolution every other files.*/git.* RPC it exposes already does.
type StreamFileChanges struct {
	resolver   ConnectionResolver
	devServers DevServerRepository
	agent      DevServerAgentClient
}

func NewStreamFileChanges(resolver ConnectionResolver, devServers DevServerRepository, agent DevServerAgentClient) *StreamFileChanges {
	return &StreamFileChanges{resolver: resolver, devServers: devServers, agent: agent}
}

// Execute mirrors Relay.Execute/RelayByDevServer.Execute's validation shape,
// but returns a stream (events, unsubscribe) instead of a single result —
// unsubscribe MUST be called exactly once by the caller (adapter/grpc's
// StreamFileChanges handler, via defer), same contract
// DevServerAgentClient.StreamFileChanges's own doc comment documents.
func (uc *StreamFileChanges) Execute(ctx context.Context, in StreamFileChangesInput) (<-chan FileChangeEvent, func(), error) {
	tenantID, err := tenant.RequireTenantID(ctx)
	if err != nil {
		return nil, nil, apperrors.New(apperrors.KindUnauthenticated, "INFRA_NO_TENANT", "no tenant in request context", err)
	}
	if in.Path == "" {
		return nil, nil, apperrors.New(apperrors.KindInvalidArgument, "INFRA_FILE_WATCH_NO_PATH", "path is required", nil)
	}

	devServer, err := uc.resolveDevServer(ctx, tenantID, in)
	if err != nil {
		return nil, nil, err
	}

	events, unsubscribe, err := uc.agent.StreamFileChanges(ctx, devServer, in.Path)
	if err != nil {
		return nil, nil, apperrors.New(apperrors.KindInternal, "INFRA_AGENT_STREAM_FILE_CHANGES_FAILED", "failed to subscribe to file changes", err)
	}
	return events, unsubscribe, nil
}

// resolveDevServer picks ConnectionResolver (ConnectionID set) or
// DevServerRepository (DevServerID set) — exactly one must be set, enforced
// by the default case below. See Relay.Execute/RelayByDevServer.Execute for
// why each addressing mode exists.
func (uc *StreamFileChanges) resolveDevServer(ctx context.Context, tenantID string, in StreamFileChangesInput) (domain.DevServer, error) {
	switch {
	case in.ConnectionID != "":
		connected, devServer, _, err := uc.resolver.ResolveConnection(ctx, tenantID, in.ConnectionID)
		if err != nil {
			return domain.DevServer{}, apperrors.New(apperrors.KindInternal, "INFRA_RESOLVE_FAILED", "failed to resolve connection", err)
		}
		if !connected {
			return domain.DevServer{}, apperrors.New(apperrors.KindNotFound, "INFRA_CONNECTION_NOT_FOUND", "no dev server owns this connectionId", nil)
		}
		return devServer, nil
	case in.DevServerID != "":
		devServer, err := uc.devServers.Get(ctx, tenantID, in.DevServerID)
		if err != nil {
			return domain.DevServer{}, apperrors.New(apperrors.KindNotFound, "INFRA_DEV_SERVER_NOT_FOUND", "dev server not found for this tenant", err)
		}
		return devServer, nil
	default:
		return domain.DevServer{}, apperrors.New(apperrors.KindInvalidArgument, "INFRA_FILE_WATCH_NO_TARGET", "connectionId or devServerId is required", nil)
	}
}
