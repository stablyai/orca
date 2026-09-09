// channels_dev_server_access_control.go wires CR-DS-006 Phase 2 / CR-DS-007 /
// CR-DS-008's admin-approval, grouping, department/team access-grant, and
// access-request RPCs onto infra-fleet-service — see
// docs/crs/v2/dev-server/CR-DS-006-dev-server-approval-and-grouping.md and
// its two follow-on CRs.
//
// Every response here goes through an explicit camelCase view struct
// (devServerGroupView/devServerGroupGrantView/devServerAccessRequestView),
// never a raw proto message — protoc-gen-go's `encoding/json` struct tags
// are snake_case (`json:"tenant_id,omitempty"`; the camelCase
// `json=tenantId` protobuf tag is protojson-only and this envelope uses
// plain encoding/json), so returning a bare *infrafleetv1.X here would
// silently ship snake_case keys the frontend's camelCase-typed code would
// never see populated.
//
// Admin-gated channels attach Identity.Role (populated end-to-end only for
// the browser cookie/session auth path — see wscompat.Identity's doc
// comment) so infra-fleet-service's requireAdmin can actually enforce
// something; every other AttachIdentity call site in this package still
// omits Role (its zero value), unchanged.
package wscompat

import (
	"context"
	"encoding/json"
	"errors"

	infrafleetv1 "github.com/stablyai/orca-go/proto/gen/go/orca/infrafleet/v1"
	tenantv1 "github.com/stablyai/orca-go/proto/gen/go/orca/tenant/v1"

	gatewaygrpc "github.com/stablyai/orca-go/services/api-gateway/internal/adapter/grpc"
	"github.com/stablyai/orca-go/services/api-gateway/internal/usecase"
)

// attachAdminIdentity is AttachIdentity plus Role — every admin-gated
// channel below uses this instead of the plain TenantID/UserID-only
// identity every other channel in this package attaches.
func attachAdminIdentity(ctx context.Context, id Identity) context.Context {
	return gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID, Role: id.Role})
}

type devServerGroupView struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	ParentGroupID string `json:"parentGroupId"`
}

func toDevServerGroupView(g *infrafleetv1.DevServerGroup) devServerGroupView {
	return devServerGroupView{ID: g.GetId(), Name: g.GetName(), ParentGroupID: g.GetParentGroupId()}
}

type devServerGroupGrantView struct {
	ID               string `json:"id"`
	DevServerGroupID string `json:"devServerGroupId"`
	GranteeKind      string `json:"granteeKind"`
	GranteeID        string `json:"granteeId"`
}

func toDevServerGroupGrantView(g *infrafleetv1.DevServerGroupGrant) devServerGroupGrantView {
	return devServerGroupGrantView{
		ID:               g.GetId(),
		DevServerGroupID: g.GetDevServerGroupId(),
		GranteeKind:      granteeKindWire(g.GetGranteeKind()),
		GranteeID:        g.GetGranteeId(),
	}
}

type devServerAccessRequestView struct {
	ID               string `json:"id"`
	UserID           string `json:"userId"`
	DevServerGroupID string `json:"devServerGroupId"`
	Status           string `json:"status"`
	Message          string `json:"message"`
	CreatedAtUnixMs  int64  `json:"createdAtUnixMs"`
}

func toDevServerAccessRequestView(r *infrafleetv1.DevServerAccessRequest) devServerAccessRequestView {
	return devServerAccessRequestView{
		ID:               r.GetId(),
		UserID:           r.GetUserId(),
		DevServerGroupID: r.GetDevServerGroupId(),
		Status:           accessRequestStatusWire(r.GetStatus()),
		Message:          r.GetMessage(),
		CreatedAtUnixMs:  r.GetCreatedAtUnixMs(),
	}
}

// granteeKindWire/accessRequestStatusWire map proto enums to the plain
// lowercase strings domain.GranteeKind/domain.AccessRequestStatus already
// use server-side — the frontend never sees the enum's SCREAMING_CASE names.
func granteeKindWire(k infrafleetv1.DevServerGroupGranteeKind) string {
	switch k {
	case infrafleetv1.DevServerGroupGranteeKind_DEV_SERVER_GROUP_GRANTEE_KIND_DEPARTMENT:
		return "department"
	case infrafleetv1.DevServerGroupGranteeKind_DEV_SERVER_GROUP_GRANTEE_KIND_TEAM:
		return "team"
	default:
		return ""
	}
}

func toProtoGranteeKindWire(kind string) infrafleetv1.DevServerGroupGranteeKind {
	switch kind {
	case "department":
		return infrafleetv1.DevServerGroupGranteeKind_DEV_SERVER_GROUP_GRANTEE_KIND_DEPARTMENT
	case "team":
		return infrafleetv1.DevServerGroupGranteeKind_DEV_SERVER_GROUP_GRANTEE_KIND_TEAM
	default:
		return infrafleetv1.DevServerGroupGranteeKind_DEV_SERVER_GROUP_GRANTEE_KIND_UNSPECIFIED
	}
}

func accessRequestStatusWire(s infrafleetv1.DevServerAccessRequestStatus) string {
	switch s {
	case infrafleetv1.DevServerAccessRequestStatus_DEV_SERVER_ACCESS_REQUEST_STATUS_PENDING:
		return "pending"
	case infrafleetv1.DevServerAccessRequestStatus_DEV_SERVER_ACCESS_REQUEST_STATUS_APPROVED:
		return "approved"
	case infrafleetv1.DevServerAccessRequestStatus_DEV_SERVER_ACCESS_REQUEST_STATUS_REJECTED:
		return "rejected"
	default:
		return ""
	}
}

func registerDevServerAccessControlChannels(r *Registry, client infrafleetv1.InfraFleetServiceClient, tenantClient tenantv1.TenantServiceClient) {
	r.Register("devServer.approve", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type approveArgs struct {
			DevServerID string `json:"devServerId"`
		}
		in, err := decodeArg[approveArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = attachAdminIdentity(ctx, id)
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		resp, err := client.ApproveDevServer(rpcCtx, &infrafleetv1.ApproveDevServerRequest{DevServerId: in.DevServerID})
		if err != nil {
			return nil, err
		}
		return toDevServerView(resp.GetDevServer()), nil
	})

	r.Register("devServer.reject", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type rejectArgs struct {
			DevServerID string `json:"devServerId"`
			Reason      string `json:"reason"`
		}
		in, err := decodeArg[rejectArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = attachAdminIdentity(ctx, id)
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		resp, err := client.RejectDevServer(rpcCtx, &infrafleetv1.RejectDevServerRequest{DevServerId: in.DevServerID, Reason: in.Reason})
		if err != nil {
			return nil, err
		}
		return toDevServerView(resp.GetDevServer()), nil
	})

	r.Register("devServer.assignGroup", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type assignArgs struct {
			DevServerID string `json:"devServerId"`
			GroupID     string `json:"groupId"`
		}
		in, err := decodeArg[assignArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = attachAdminIdentity(ctx, id)
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		resp, err := client.AssignDevServerGroup(rpcCtx, &infrafleetv1.AssignDevServerGroupRequest{DevServerId: in.DevServerID, GroupId: in.GroupID})
		if err != nil {
			return nil, err
		}
		return toDevServerView(resp.GetDevServer()), nil
	})

	r.Register("devServerGroup.create", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type createArgs struct {
			Name          string `json:"name"`
			ParentGroupID string `json:"parentGroupId"`
		}
		in, err := decodeArg[createArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = attachAdminIdentity(ctx, id)
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		resp, err := client.CreateDevServerGroup(rpcCtx, &infrafleetv1.CreateDevServerGroupRequest{Name: in.Name, ParentGroupId: in.ParentGroupID})
		if err != nil {
			return nil, err
		}
		return toDevServerGroupView(resp.GetGroup()), nil
	})

	r.Register("devServerGroup.list", func(ctx context.Context, id Identity, _ []json.RawMessage) (any, error) {
		ctx = attachAdminIdentity(ctx, id)
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		resp, err := client.ListDevServerGroups(rpcCtx, &infrafleetv1.ListDevServerGroupsRequest{})
		if err != nil {
			return nil, err
		}
		views := make([]devServerGroupView, 0, len(resp.GetGroups()))
		for _, g := range resp.GetGroups() {
			views = append(views, toDevServerGroupView(g))
		}
		return map[string]any{"groups": views}, nil
	})

	r.Register("devServerGroup.grant", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type grantArgs struct {
			DevServerGroupID string `json:"devServerGroupId"`
			GranteeKind      string `json:"granteeKind"` // "department" | "team"
			GranteeID        string `json:"granteeId"`
		}
		in, err := decodeArg[grantArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = attachAdminIdentity(ctx, id)
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		resp, err := client.GrantDevServerGroupAccess(rpcCtx, &infrafleetv1.GrantDevServerGroupAccessRequest{
			DevServerGroupId: in.DevServerGroupID,
			GranteeKind:      toProtoGranteeKindWire(in.GranteeKind),
			GranteeId:        in.GranteeID,
		})
		if err != nil {
			return nil, err
		}
		return toDevServerGroupGrantView(resp.GetGrant()), nil
	})

	r.Register("devServerGroup.revoke", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type revokeArgs struct {
			GrantID string `json:"grantId"`
		}
		in, err := decodeArg[revokeArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = attachAdminIdentity(ctx, id)
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		_, err = client.RevokeDevServerGroupAccess(rpcCtx, &infrafleetv1.RevokeDevServerGroupAccessRequest{GrantId: in.GrantID})
		return nil, err
	})

	r.Register("devServerGroup.listGrants", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type listGrantsArgs struct {
			DevServerGroupID string `json:"devServerGroupId"`
		}
		in, _ := decodeArg[listGrantsArgs](args, 0) // best-effort — empty groupId means "every grant"
		ctx = attachAdminIdentity(ctx, id)
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		resp, err := client.ListDevServerGroupGrants(rpcCtx, &infrafleetv1.ListDevServerGroupGrantsRequest{DevServerGroupId: in.DevServerGroupID})
		if err != nil {
			return nil, err
		}
		views := make([]devServerGroupGrantView, 0, len(resp.GetGrants()))
		for _, g := range resp.GetGrants() {
			views = append(views, toDevServerGroupGrantView(g))
		}
		return map[string]any{"grants": views}, nil
	})

	// devServer.listForUser — NOT admin-gated. Resolves the caller's
	// department via tenant-service.GetUserProfile and the caller's team
	// memberships via tenant-service.ListTeamsForUser (both real RPCs), then
	// calls infra-fleet-service.ListDevServersForUser with both populated.
	// BUG-013's fix: team_ids used to always be empty here because
	// tenant-service had no "list teams for user" RPC (see git blame on this
	// comment for the old doc comment describing that gap).
	r.Register("devServer.listForUser", func(ctx context.Context, id Identity, _ []json.RawMessage) (any, error) {
		gwCtx := gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(gwCtx, rpcTimeout)
		defer cancel()
		profileResp, err := tenantClient.GetUserProfile(rpcCtx, &tenantv1.GetUserProfileRequest{UserId: id.UserID})
		if err != nil {
			return nil, err
		}
		departmentID := profileResp.GetProfile().GetDepartmentId()

		teamsRpcCtx, teamsCancel := context.WithTimeout(gwCtx, rpcTimeout)
		defer teamsCancel()
		teamsResp, err := tenantClient.ListTeamsForUser(teamsRpcCtx, &tenantv1.ListTeamsForUserRequest{UserId: id.UserID})
		if err != nil {
			// Deliberate fail-closed choice (TASK-BE-013), not an oversight:
			// degrading to department-only visibility on a tenant-service
			// outage would silently under-provision team-granted dev
			// servers — the exact BUG-013 failure mode under a new trigger.
			return nil, err
		}

		fleetRpcCtx, fleetCancel := context.WithTimeout(gwCtx, rpcTimeout)
		defer fleetCancel()
		resp, err := client.ListDevServersForUser(fleetRpcCtx, &infrafleetv1.ListDevServersForUserRequest{
			DepartmentId: departmentID,
			TeamIds:      teamsResp.GetTeamIds(),
		})
		if err != nil {
			return nil, err
		}
		views := make([]devServerView, 0, len(resp.GetDevServers()))
		for _, ds := range resp.GetDevServers() {
			views = append(views, attachConnectionStatus(gwCtx, client, toDevServerView(ds)))
		}
		return map[string]any{"devServers": views}, nil
	})

	r.Register("devServer.requestAccess", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type requestArgs struct {
			DevServerGroupID string `json:"devServerGroupId"`
			Message          string `json:"message"`
		}
		in, err := decodeArg[requestArgs](args, 0)
		if err != nil {
			return nil, err
		}
		gwCtx := gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})

		profileRpcCtx, profileCancel := context.WithTimeout(gwCtx, rpcTimeout)
		defer profileCancel()
		profileResp, err := tenantClient.GetUserProfile(profileRpcCtx, &tenantv1.GetUserProfileRequest{UserId: id.UserID})
		if err != nil {
			return nil, err
		}
		departmentID := profileResp.GetProfile().GetDepartmentId()
		if departmentID == "" {
			return nil, errors.New("caller has no department — cannot file an access request until one is set")
		}

		rpcCtx, cancel := context.WithTimeout(gwCtx, rpcTimeout)
		defer cancel()
		resp, err := client.CreateAccessRequest(rpcCtx, &infrafleetv1.CreateAccessRequestRequest{
			DevServerGroupId: in.DevServerGroupID,
			Message:          in.Message,
			GranteeKind:      infrafleetv1.DevServerGroupGranteeKind_DEV_SERVER_GROUP_GRANTEE_KIND_DEPARTMENT,
			GranteeId:        departmentID,
		})
		if err != nil {
			return nil, err
		}
		return toDevServerAccessRequestView(resp.GetRequest()), nil
	})

	r.Register("devServer.listPendingAccessRequests", func(ctx context.Context, id Identity, _ []json.RawMessage) (any, error) {
		ctx = attachAdminIdentity(ctx, id)
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		resp, err := client.ListPendingAccessRequests(rpcCtx, &infrafleetv1.ListPendingAccessRequestsRequest{})
		if err != nil {
			return nil, err
		}
		views := make([]devServerAccessRequestView, 0, len(resp.GetRequests()))
		for _, req := range resp.GetRequests() {
			views = append(views, toDevServerAccessRequestView(req))
		}
		return map[string]any{"requests": views}, nil
	})

	r.Register("devServer.resolveAccessRequest", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type resolveArgs struct {
			RequestID string `json:"requestId"`
			Approve   bool   `json:"approve"`
		}
		in, err := decodeArg[resolveArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = attachAdminIdentity(ctx, id)
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		resp, err := client.ResolveAccessRequest(rpcCtx, &infrafleetv1.ResolveAccessRequestRequest{RequestId: in.RequestID, Approve: in.Approve})
		if err != nil {
			return nil, err
		}
		out := map[string]any{"request": toDevServerAccessRequestView(resp.GetRequest())}
		if in.Approve && resp.GetGrant() != nil {
			out["grant"] = toDevServerGroupGrantView(resp.GetGrant())
		} else {
			out["grant"] = nil
		}
		return out, nil
	})
}
