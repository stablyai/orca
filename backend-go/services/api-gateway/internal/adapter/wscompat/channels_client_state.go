// clientState.*/workspaceSession.* channel wiring (CR-STORAGE-001/003/
// 004a,b) — exposes tenant-service's 5 new GetClientState/SetClientState/
// GetWorkspaceSession/SetWorkspaceSession/PatchWorkspaceSession RPCs
// (TASK-BE-STORAGE-003) over wscompat, mirroring channels_tenant_project.go's
// profile.* namespace-per-file convention. See specs/backend-go/crs/v3/
// storage/solutions/BE-SOL-STORAGE-001-user-profile-json-columns.md §6.
package wscompat

import (
	"context"
	"encoding/json"
	"fmt"

	tenantv1 "github.com/stablyai/orca-go/proto/gen/go/orca/tenant/v1"

	gatewaygrpc "github.com/stablyai/orca-go/services/api-gateway/internal/adapter/grpc"
	"github.com/stablyai/orca-go/services/api-gateway/internal/usecase"
)

// RegisterClientStateChannels wires clientState.*/workspaceSession.* —
// called directly from main.go's composition root (like RegisterPushChannels),
// not from RegisterRealChannels, so this group's addition doesn't collide
// with other parallel edits to channels.go/RegisterRealChannels's own
// signature.
func RegisterClientStateChannels(r *Registry, tenantClient tenantv1.TenantServiceClient) {
	registerClientStateChannels(r, tenantClient)
}

// parseClientStateKind maps the wscompat wire kind string onto
// tenantv1.ClientStateKind — an unknown kind is a caller bug, reported as an
// error rather than silently falling back to CLIENT_STATE_KIND_UNSPECIFIED
// (which tenant-service's own columnForKind would reject anyway, but
// failing fast here gives a clearer error message).
func parseClientStateKind(kind string) (tenantv1.ClientStateKind, error) {
	switch kind {
	case "keybindings":
		return tenantv1.ClientStateKind_CLIENT_STATE_KIND_KEYBINDINGS, nil
	case "uiLocal":
		return tenantv1.ClientStateKind_CLIENT_STATE_KIND_UI_LOCAL, nil
	case "savedRuntimeEnvironments":
		return tenantv1.ClientStateKind_CLIENT_STATE_KIND_SAVED_RUNTIME_ENVIRONMENTS, nil
	case "settings":
		return tenantv1.ClientStateKind_CLIENT_STATE_KIND_SETTINGS, nil
	case "accountsDevServerMap":
		return tenantv1.ClientStateKind_CLIENT_STATE_KIND_ACCOUNTS_DEV_SERVER_MAP, nil
	default:
		return tenantv1.ClientStateKind_CLIENT_STATE_KIND_UNSPECIFIED, fmt.Errorf("unknown clientState kind: %s", kind)
	}
}

func registerClientStateChannels(r *Registry, tenantClient tenantv1.TenantServiceClient) {
	r.Register("clientState.get", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type getArgs struct {
			Kind string `json:"kind"`
		}
		in, err := decodeArg[getArgs](args, 0)
		if err != nil {
			return nil, err
		}
		kind, err := parseClientStateKind(in.Kind)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		// id.UserID — from the authenticated Identity, NEVER args — even if
		// the frontend someday sends a userId field, it must never override
		// whose state this call reads.
		resp, err := tenantClient.GetClientState(rpcCtx, &tenantv1.GetClientStateRequest{
			UserId: id.UserID, Kind: kind,
		})
		if err != nil {
			return nil, err
		}
		if !resp.GetFound() {
			return map[string]any{"found": false}, nil
		}
		return map[string]any{"found": true, "stateJson": resp.GetStateJson()}, nil
	})

	r.Register("clientState.set", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type setArgs struct {
			Kind      string `json:"kind"`
			StateJSON string `json:"stateJson"`
		}
		in, err := decodeArg[setArgs](args, 0)
		if err != nil {
			return nil, err
		}
		kind, err := parseClientStateKind(in.Kind)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		if _, err := tenantClient.SetClientState(rpcCtx, &tenantv1.SetClientStateRequest{
			UserId: id.UserID, Kind: kind, StateJson: in.StateJSON,
		}); err != nil {
			return nil, err
		}
		return map[string]bool{"ok": true}, nil
	})

	r.Register("workspaceSession.get", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type getArgs struct {
			HostID string `json:"hostId"`
		}
		// decodeOptionalArg: hostId empty/omitted means the default/local
		// host — a valid, expected call shape, not a caller error (see
		// GetWorkspaceSessionRequest's proto doc comment).
		in := decodeOptionalArg[getArgs](args, 0)
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		resp, err := tenantClient.GetWorkspaceSession(rpcCtx, &tenantv1.GetWorkspaceSessionRequest{
			UserId: id.UserID, HostId: in.HostID,
		})
		if err != nil {
			return nil, err
		}
		if !resp.GetFound() {
			return map[string]any{"found": false}, nil
		}
		return map[string]any{"found": true, "sessionJson": resp.GetSessionJson()}, nil
	})

	r.Register("workspaceSession.set", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type setArgs struct {
			HostID      string `json:"hostId"`
			SessionJSON string `json:"sessionJson"`
		}
		in, err := decodeArg[setArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		if _, err := tenantClient.SetWorkspaceSession(rpcCtx, &tenantv1.SetWorkspaceSessionRequest{
			UserId: id.UserID, HostId: in.HostID, SessionJson: in.SessionJSON,
		}); err != nil {
			return nil, err
		}
		return map[string]bool{"ok": true}, nil
	})

	r.Register("workspaceSession.patch", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type patchArgs struct {
			HostID    string `json:"hostId"`
			PatchJSON string `json:"patchJson"`
		}
		in, err := decodeArg[patchArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		if _, err := tenantClient.PatchWorkspaceSession(rpcCtx, &tenantv1.PatchWorkspaceSessionRequest{
			UserId: id.UserID, HostId: in.HostID, PatchJson: in.PatchJSON,
		}); err != nil {
			return nil, err
		}
		return map[string]bool{"ok": true}, nil
	})
}
