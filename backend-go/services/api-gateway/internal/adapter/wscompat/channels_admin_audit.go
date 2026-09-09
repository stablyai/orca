// channels_admin_audit.go wires auth-service's QueryAuditLog RPC to the
// frontend — CR-RBAC-001, BE-SOL-008 §2.3. Written directly against the
// full filter set (actor/action/outcome) since TASK-BE-016 had already
// landed those QueryAuditLogRequest fields by the time this file was
// written — no two-pass base-then-filters split needed.
package wscompat

import (
	"context"
	"encoding/json"
	"time"

	authv1 "github.com/stablyai/orca-go/proto/gen/go/orca/auth/v1"
	"google.golang.org/protobuf/types/known/timestamppb"

	gatewaygrpc "github.com/stablyai/orca-go/services/api-gateway/internal/adapter/grpc"
	"github.com/stablyai/orca-go/services/api-gateway/internal/usecase"
)

type auditEntryView struct {
	ID               string `json:"id"`
	ActorID          string `json:"actorId"`
	Action           string `json:"action"`
	Target           string `json:"target"`
	Outcome          string `json:"outcome"`
	IPAddress        string `json:"ipAddress"`
	OccurredAtUnixMs int64  `json:"occurredAtUnixMs"`
}

func toAuditEntryView(e *authv1.AuditEntry) auditEntryView {
	var occurredAtUnixMs int64
	if ts := e.GetOccurredAt(); ts != nil {
		occurredAtUnixMs = ts.AsTime().UnixMilli()
	}
	return auditEntryView{
		ID: e.GetId(), ActorID: e.GetActorId(), Action: e.GetAction(), Target: e.GetTarget(),
		Outcome: e.GetOutcome(), IPAddress: e.GetIpAddress(), OccurredAtUnixMs: occurredAtUnixMs,
	}
}

func registerAdminAuditChannels(r *Registry, client authv1.AuthServiceClient) {
	r.Register("admin.queryAuditLog", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		if id.Role != "admin" {
			return nil, errNotAdmin
		}
		type queryArgs struct {
			SinceUnixMs int64  `json:"sinceUnixMs"`
			ActorID     string `json:"actorId"`
			Action      string `json:"action"`
			Outcome     string `json:"outcome"`
			PageToken   string `json:"pageToken"`
			PageSize    int32  `json:"pageSize"`
		}
		in := decodeOptionalArg[queryArgs](args, 0)
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID, Role: id.Role})
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		req := &authv1.QueryAuditLogRequest{
			TenantId: id.TenantID, PageToken: in.PageToken, PageSize: in.PageSize,
			ActorId: in.ActorID, Action: in.Action, Outcome: in.Outcome,
		}
		if in.SinceUnixMs > 0 {
			req.Since = timestamppb.New(time.UnixMilli(in.SinceUnixMs))
		}
		resp, err := client.QueryAuditLog(rpcCtx, req)
		if err != nil {
			return nil, err
		}
		views := make([]auditEntryView, 0, len(resp.GetEntries()))
		for _, e := range resp.GetEntries() {
			views = append(views, toAuditEntryView(e))
		}
		return map[string]any{"entries": views, "nextPageToken": resp.GetNextPageToken()}, nil
	})
}
