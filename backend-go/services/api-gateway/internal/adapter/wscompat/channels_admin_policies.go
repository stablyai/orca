// channels_admin_policies.go wires auth-service's AccessPolicy CRUD RPCs
// (CreateAccessPolicy/GetAccessPolicy/ListAccessPolicies/UpdateAccessPolicy/
// DeleteAccessPolicy) to the frontend — TASK-BE-001 confirmed all 5 already
// exist server-side, but no wscompat channel reached them (CR-RBAC-001,
// BE-SOL-008 §2.1).
//
// Editing a policy through these channels has no real enforcement effect
// until the OPA-bundle publish pipeline is wired live (CR-RBAC-006,
// TASK-BE-024/025/027) — document as a known limitation in the Policies tab
// UI if that lands after this file does.
package wscompat

import (
	"context"
	"encoding/json"

	authv1 "github.com/stablyai/orca-go/proto/gen/go/orca/auth/v1"

	gatewaygrpc "github.com/stablyai/orca-go/services/api-gateway/internal/adapter/grpc"
	"github.com/stablyai/orca-go/services/api-gateway/internal/usecase"
)

type policyView struct {
	ID              string `json:"id"`
	Name            string `json:"name"`
	Kind            string `json:"kind"`
	DocumentJSON    string `json:"documentJson"`
	Version         int32  `json:"version"`
	UpdatedBy       string `json:"updatedBy"`
	UpdatedAtUnixMs int64  `json:"updatedAtUnixMs"`
}

func toPolicyView(p *authv1.AccessPolicy) policyView {
	var updatedAtUnixMs int64
	if ts := p.GetUpdatedAt(); ts != nil {
		updatedAtUnixMs = ts.AsTime().UnixMilli()
	}
	return policyView{
		ID: p.GetId(), Name: p.GetName(), Kind: p.GetKind(),
		DocumentJSON: p.GetDocumentJson(), Version: p.GetVersion(),
		UpdatedBy: p.GetUpdatedBy(), UpdatedAtUnixMs: updatedAtUnixMs,
	}
}

func registerAdminPolicyChannels(r *Registry, client authv1.AuthServiceClient) {
	r.Register("admin.listPolicies", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		if id.Role != "admin" {
			return nil, errNotAdmin
		}
		type listArgs struct {
			PageToken string `json:"pageToken"`
			PageSize  int32  `json:"pageSize"`
		}
		in := decodeOptionalArg[listArgs](args, 0)
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID, Role: id.Role})
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		resp, err := client.ListAccessPolicies(rpcCtx, &authv1.ListAccessPoliciesRequest{
			PageToken: in.PageToken, PageSize: in.PageSize,
		})
		if err != nil {
			return nil, err
		}
		views := make([]policyView, 0, len(resp.GetPolicies()))
		for _, p := range resp.GetPolicies() {
			views = append(views, toPolicyView(p))
		}
		return map[string]any{"policies": views, "nextPageToken": resp.GetNextPageToken()}, nil
	})

	r.Register("admin.getPolicy", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		if id.Role != "admin" {
			return nil, errNotAdmin
		}
		type getArgs struct {
			PolicyID string `json:"policyId"`
		}
		in, err := decodeArg[getArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID, Role: id.Role})
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		resp, err := client.GetAccessPolicy(rpcCtx, &authv1.GetAccessPolicyRequest{Id: in.PolicyID})
		if err != nil {
			return nil, err
		}
		return toPolicyView(resp), nil
	})

	r.Register("admin.createPolicy", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		if id.Role != "admin" {
			return nil, errNotAdmin
		}
		type createArgs struct {
			Name         string `json:"name"`
			Kind         string `json:"kind"`
			DocumentJSON string `json:"documentJson"`
		}
		in, err := decodeArg[createArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID, Role: id.Role})
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		resp, err := client.CreateAccessPolicy(rpcCtx, &authv1.CreateAccessPolicyRequest{
			Name: in.Name, Kind: in.Kind, DocumentJson: in.DocumentJSON,
		})
		if err != nil {
			return nil, err
		}
		return toPolicyView(resp), nil
	})

	r.Register("admin.updatePolicy", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		if id.Role != "admin" {
			return nil, errNotAdmin
		}
		type updateArgs struct {
			PolicyID        string `json:"policyId"`
			DocumentJSON    string `json:"documentJson"`
			ExpectedVersion int32  `json:"expectedVersion"`
		}
		in, err := decodeArg[updateArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID, Role: id.Role})
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		resp, err := client.UpdateAccessPolicy(rpcCtx, &authv1.UpdateAccessPolicyRequest{
			Id: in.PolicyID, DocumentJson: in.DocumentJSON, ExpectedVersion: in.ExpectedVersion,
		})
		if err != nil {
			return nil, err
		}
		return toPolicyView(resp), nil
	})

	r.Register("admin.deletePolicy", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		if id.Role != "admin" {
			return nil, errNotAdmin
		}
		type deleteArgs struct {
			PolicyID string `json:"policyId"`
		}
		in, err := decodeArg[deleteArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID, Role: id.Role})
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		_, err = client.DeleteAccessPolicy(rpcCtx, &authv1.DeleteAccessPolicyRequest{Id: in.PolicyID})
		if err != nil {
			return nil, err
		}
		return map[string]any{"ok": true}, nil
	})
}
