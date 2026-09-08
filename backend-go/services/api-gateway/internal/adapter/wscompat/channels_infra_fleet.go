// channels_infra_fleet.go wires CR-STORAGE-007's poll-driven connectivity
// health summary onto infra-fleet-service — see BE-SOL-STORAGE-002 §3-4 and
// TASK-BE-STORAGE-008. Kept in its own file (not appended to channels.go's
// registerFleetChannels) per that task's file-scope: this is a standalone,
// self-contained addition landing independently of channels.go's other
// groups.
//
// connectionHealthView, not a raw *infrafleetv1.ConnectionHealthEntry: same
// bug class documented at the top of channels_dev_server_access_control.go
// and channels_tenant_project.go — protoc-gen-go's own `encoding/json`
// struct tags are snake_case (`json:"connection_id,omitempty"`), but this
// envelope's Result field is serialized via plain encoding/json, not
// protojson. Returning the proto message directly would silently ship
// connection_id/dev_server_id/etc. instead of the camelCase keys the
// frontend's TypeScript expects.
package wscompat

import (
	"context"
	"encoding/json"
	"fmt"

	infrafleetv1 "github.com/stablyai/orca-go/proto/gen/go/orca/infrafleet/v1"

	gatewaygrpc "github.com/stablyai/orca-go/services/api-gateway/internal/adapter/grpc"
	"github.com/stablyai/orca-go/services/api-gateway/internal/usecase"
)

// connectionHealthView mirrors infrafleet.proto's ConnectionHealthEntry
// field-for-field, in camelCase. LastActivityAt/DegradedSince use
// `omitempty` int64-millis (via protoTimeMillis, already declared in
// channels_emulator_folderworkspace_host.go): the proto doc comment says
// each is "unset if never active"/"unset unless status == degraded", so 0
// (and the key vanishing from the JSON object) is the honest wire
// representation of "unset", not a fabricated epoch timestamp.
type connectionHealthView struct {
	ConnectionID   string `json:"connectionId"`
	DevServerID    string `json:"devServerId"`
	Status         string `json:"status"`
	LastActivityAt int64  `json:"lastActivityAt,omitempty"`
	DegradedSince  int64  `json:"degradedSince,omitempty"`
}

func toConnectionHealthView(e *infrafleetv1.ConnectionHealthEntry) connectionHealthView {
	return connectionHealthView{
		ConnectionID:   e.GetConnectionId(),
		DevServerID:    e.GetDevServerId(),
		Status:         e.GetStatus(),
		LastActivityAt: protoTimeMillis(e.GetLastActivityAt()),
		DegradedSince:  protoTimeMillis(e.GetDegradedSince()),
	}
}

// registerInfraFleetChannels wires connectivity.getSummary — CR-STORAGE-007's
// poll target for FE-TASK-STORAGE-012/014. Called from RegisterRealChannels
// alongside the other registerXChannels(r, infraFleetClient) calls.
func registerInfraFleetChannels(r *Registry, client infrafleetv1.InfraFleetServiceClient) {
	r.Register("connectivity.getSummary", func(ctx context.Context, id Identity, _ []json.RawMessage) (any, error) {
		// Request body ignored — tenant/user scoping comes from Identity via
		// gRPC metadata (AttachIdentity), never from caller-supplied args.
		// GetFleetConnectivitySummaryRequest is deliberately empty on the
		// wire (infrafleet.proto's own doc comment) for exactly this reason:
		// there is no field here a forged args payload could smuggle a
		// different tenantId/userId through.
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		resp, err := client.GetFleetConnectivitySummary(rpcCtx, &infrafleetv1.GetFleetConnectivitySummaryRequest{})
		if err != nil {
			return nil, err
		}
		// []connectionHealthView, not resp.GetConnections(): keeps the
		// established "empty list channels return [] not null" convention
		// (see toDepartmentView's call site in channels_tenant_project.go) —
		// a nil proto slice converts to a non-nil empty slice here.
		conns := resp.GetConnections()
		views := make([]connectionHealthView, 0, len(conns))
		for _, c := range conns {
			views = append(views, toConnectionHealthView(c))
		}
		return map[string]any{"connections": views}, nil
	})

	// connection.teardown — TASK-BE-STORAGE-012's TeardownConnection RPC
	// (BE-SOL-STORAGE-003 §5), exposed for FE-TASK-STORAGE-016's confirmed-
	// logout path (useLogout's closeAllActiveSessions()). Bypasses the
	// connection's grace_period_seconds entirely — closes it and every
	// terminal session bound to it immediately, per
	// Connection.CloseExplicitly()'s contract. connectionId is the only
	// caller-supplied field (tenant scoping still comes from Identity via
	// AttachIdentity, never from args) because TeardownConnectionRequest's
	// own proto doc comment says the same: "tenant scoping comes from the
	// authenticated context."
	r.Register("connection.teardown", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		in, err := decodeArg[connectionTeardownArgs](args, 0)
		if err != nil {
			return nil, err
		}
		if in.ConnectionID == "" {
			return nil, fmt.Errorf("CONNECTION_TEARDOWN_MISSING_ID: connectionId is required")
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		if _, err := client.TeardownConnection(rpcCtx, &infrafleetv1.TeardownConnectionRequest{ConnectionId: in.ConnectionID}); err != nil {
			return nil, err
		}
		return map[string]any{"ok": true}, nil
	})
}

// connectionTeardownArgs — connection.teardown's only argument. Named to
// match the frontend's existing `connectionId` field
// (FE-SOL-STORAGE-007/016's closeAllActiveSessions(), which already
// iterates connectivityStatus's connections keyed this way).
type connectionTeardownArgs struct {
	ConnectionID string `json:"connectionId"`
}
