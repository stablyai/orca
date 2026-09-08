// Package grpcclient contains git-gateway-service's outbound gRPC client
// adapters for infra-fleet-service — this service's dependency for
// connection resolution and relay dispatch (git-gateway-service.md §7: "the
// only two Go services that talk to the execution plane"). Both adapters
// here (ConnectionResolver in this file, RelayExecutor in
// relay_executor.go) wrap the same *grpc.ClientConn dialed once in
// cmd/server/main.go and forward the caller's tenant identity on every RPC
// via withTenantMetadata (tenant_forwarding.go).
package grpcclient

import (
	"context"
	"fmt"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	infrafleetv1 "github.com/stablyai/orca-go/proto/gen/go/orca/infrafleet/v1"
	"github.com/stablyai/orca-go/services/git-gateway-service/internal/usecase"
)

// ConnectionResolver implements usecase.ConnectionResolver by calling
// infra-fleet-service's ResolveConnection RPC.
type ConnectionResolver struct {
	client infrafleetv1.InfraFleetServiceClient
}

// Dial opens a gRPC client connection to infra-fleet-service at addr — the
// same lazy-dial pattern api-gateway's internal/adapter/grpc/dial.go uses
// (grpc.NewClient doesn't block on connect, so infra-fleet-service being
// down doesn't fail this service's startup). Shared by both
// NewConnectionResolver and NewRelayExecutor's callers in cmd/server/main.go
// so a single connection backs both adapters.
//
// Insecure transport credentials — acceptable for local dev only; see
// api-gateway's Dial doc comment for the production mTLS gap this mirrors.
func Dial(addr string) (*grpc.ClientConn, error) {
	conn, err := grpc.NewClient(addr, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return nil, fmt.Errorf("grpcclient: dial infra-fleet-service at %q: %w", addr, err)
	}
	return conn, nil
}

// NewConnectionResolver wraps an already-constructed infrafleetv1 client —
// used with Dial's connection in cmd/server/main.go, and with a fake client
// in tests.
func NewConnectionResolver(client infrafleetv1.InfraFleetServiceClient) *ConnectionResolver {
	return &ConnectionResolver{client: client}
}

// ResolveConnection asks infra-fleet-service which host owns worktreeID.
//
// worktreeID is NOT the infra-fleet-service connectionId — infra.connections
// has its own UUID primary key (migrations/0002_connections.up.sql), separate
// from the TEXT worktree_id column that stores git-gateway-service's
// "repoId::path" worktree IDs. Sending worktreeID as ConnectionId (this
// method's prior, incorrect behavior) hits infra.connections.id's uuid
// column type and fails with "invalid input syntax for type uuid" for every
// non-UUID worktreeID — live-confirmed as GITGATEWAY_RESOLVE_FAILED's root
// cause on every dev-server-backed worktree's Git panel. WorktreeId is the
// correct request key (mirrors api-gateway's channels_browser.go), routing
// to ResolveConnectionByWorktree's worktree_id-keyed lookup instead. The
// resolved ConnectionID must come from the response (resp.GetConnectionId())
// — infra.connections.id — not be echoed back as worktreeID, since
// RelayExecutor.relay's Relay RPC also requires that real UUID as its own
// ConnectionId (see relay_executor.go's Complete doc comment).
func (r *ConnectionResolver) ResolveConnection(ctx context.Context, worktreeID string) (usecase.ResolvedConnection, error) {
	ctx, err := withTenantMetadata(ctx)
	if err != nil {
		return usecase.ResolvedConnection{}, err
	}

	resp, err := r.client.ResolveConnection(ctx, &infrafleetv1.ResolveConnectionRequest{
		WorktreeId: worktreeID,
	})
	if err != nil {
		return usecase.ResolvedConnection{}, fmt.Errorf("grpcclient: ResolveConnection(%q): %w", worktreeID, err)
	}

	if !resp.GetConnected() {
		return usecase.ResolvedConnection{Connected: false, RepoPath: worktreeID}, nil
	}
	return usecase.ResolvedConnection{
		Connected:    true,
		ConnectionID: resp.GetConnectionId(),
		RepoPath:     resp.GetRepoPath(),
		// HiddenTargetID (TASK-BE-EVM-018, BE-SOL-EVM-004 §6c — closes
		// TASK-BE-EVM-015's gap #1): infrafleetv1.ResolveConnectionResponse
		// now carries this field for real. dispatchExecutor (ports.go)
		// still deliberately does not thread it into ctx — see that
		// function's own doc comment — but the value itself is no longer
		// silently dropped here.
		HiddenTargetID: resp.GetHiddenTargetId(),
	}, nil
}
