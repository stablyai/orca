// channels_admin_sessions.go wires auth-service's session-management RPCs
// (ListSessionsForUser/ForceRevokeAllSessionsForUser/ForceRevokeSession) to
// the frontend — CR-RBAC-001, BE-SOL-008 §2.2.
//
// admin.forceRevokeSession calls ForceRevokeSession (TASK-BE-002), NOT
// RevokeSession — RevokeSession expects the RAW session token, but
// ListSessionsForUser's Session.Id (what this channel's caller has) is
// already the token HASH. See force_revoke_session.go's doc comment for
// why the two cannot be interchanged.
package wscompat

import (
	"context"
	"encoding/json"

	authv1 "github.com/stablyai/orca-go/proto/gen/go/orca/auth/v1"

	gatewaygrpc "github.com/stablyai/orca-go/services/api-gateway/internal/adapter/grpc"
	"github.com/stablyai/orca-go/services/api-gateway/internal/usecase"
)

type sessionView struct {
	SessionID        string `json:"sessionId"`
	UserID           string `json:"userId"`
	IP               string `json:"ip"`
	UserAgent        string `json:"userAgent"`
	CreatedAtUnixMs  int64  `json:"createdAtUnixMs"`
	ExpiresAtUnixMs  int64  `json:"expiresAtUnixMs"`
	LastSeenAtUnixMs int64  `json:"lastSeenAtUnixMs"`
}

func toSessionView(s *authv1.Session) sessionView {
	var createdAtUnixMs, expiresAtUnixMs, lastSeenAtUnixMs int64
	if ts := s.GetCreatedAt(); ts != nil {
		createdAtUnixMs = ts.AsTime().UnixMilli()
	}
	if ts := s.GetExpiresAt(); ts != nil {
		expiresAtUnixMs = ts.AsTime().UnixMilli()
	}
	if ts := s.GetLastSeenAt(); ts != nil {
		lastSeenAtUnixMs = ts.AsTime().UnixMilli()
	}
	return sessionView{
		SessionID: s.GetId(), UserID: s.GetUserId(), IP: s.GetIp(), UserAgent: s.GetUserAgent(),
		CreatedAtUnixMs: createdAtUnixMs, ExpiresAtUnixMs: expiresAtUnixMs, LastSeenAtUnixMs: lastSeenAtUnixMs,
	}
}

func registerAdminSessionChannels(r *Registry, client authv1.AuthServiceClient) {
	r.Register("admin.listSessions", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		if id.Role != "admin" {
			return nil, errNotAdmin
		}
		type listArgs struct {
			UserID string `json:"userId"`
		}
		in, err := decodeArg[listArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID, Role: id.Role})
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		resp, err := client.ListSessionsForUser(rpcCtx, &authv1.ListSessionsForUserRequest{UserId: in.UserID})
		if err != nil {
			return nil, err
		}
		views := make([]sessionView, 0, len(resp.GetSessions()))
		for _, s := range resp.GetSessions() {
			views = append(views, toSessionView(s))
		}
		return map[string]any{"sessions": views}, nil
	})

	r.Register("admin.forceRevokeAllSessions", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		if id.Role != "admin" {
			return nil, errNotAdmin
		}
		type revokeAllArgs struct {
			UserID string `json:"userId"`
		}
		in, err := decodeArg[revokeAllArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID, Role: id.Role})
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		resp, err := client.ForceRevokeAllSessionsForUser(rpcCtx, &authv1.ForceRevokeAllSessionsForUserRequest{UserId: in.UserID})
		if err != nil {
			return nil, err
		}
		return map[string]any{"revokedCount": resp.GetRevokedCount()}, nil
	})

	r.Register("admin.forceRevokeSession", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		if id.Role != "admin" {
			return nil, errNotAdmin
		}
		type revokeArgs struct {
			SessionID string `json:"sessionId"`
		}
		in, err := decodeArg[revokeArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID, Role: id.Role})
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		_, err = client.ForceRevokeSession(rpcCtx, &authv1.ForceRevokeSessionRequest{SessionId: in.SessionID})
		if err != nil {
			return nil, err
		}
		return map[string]any{"ok": true}, nil
	})
}
