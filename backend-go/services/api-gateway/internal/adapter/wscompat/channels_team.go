// ── team.* (tenant-service) ──────────────────────────────────────────────
//
// Every handler below calls gatewaygrpc.AttachIdentity before invoking the
// client: tenant-service binds tenant_id from gRPC metadata for every
// mutating/scoped call per tenant-service.md's "every request carries
// tenant_id explicitly... never inferred from a nested resource ID" rule
// (§3) — same posture devServer.*/fleet.* already use in channels.go, for
// the same reason.
package wscompat

import (
	"context"
	"encoding/json"

	tenantv1 "github.com/stablyai/orca-go/proto/gen/go/orca/tenant/v1"

	gatewaygrpc "github.com/stablyai/orca-go/services/api-gateway/internal/adapter/grpc"
	"github.com/stablyai/orca-go/services/api-gateway/internal/usecase"
)

// registerTeamChannels wires all 5 team.* wscompat channels against
// tenant-service, called from channels.go's RegisterRealChannels.
//
// Admin-gated (CR-RBAC-001/TASK-BE-032, 2026-09-11): the only planned
// consumer is the Admin Console's Teams tab — nothing else calls team.*
// today (confirmed: no frontend/ preload bridge exists yet for it). A
// stand-alone channels_admin_teams.go was drafted first, then found to
// duplicate this file entirely (same 5 operations) and discarded in favor
// of admin-gating these instead, rather than running two parallel channel
// groups for identical operations.
func registerTeamChannels(r *Registry, client tenantv1.TenantServiceClient) {
	r.Register("team.create", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		if id.Role != "admin" {
			return nil, errNotAdmin
		}
		type createArgs struct {
			Name         string `json:"name"`
			SettingsJSON string `json:"settingsJson"`
		}
		in, err := decodeArg[createArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		resp, err := client.CreateTeam(ctx, &tenantv1.CreateTeamRequest{
			CompanyId: id.TenantID, Name: in.Name, SettingsJson: in.SettingsJSON,
		})
		if err != nil {
			return nil, err
		}
		return resp.GetTeam(), nil
	})

	r.Register("team.list", func(ctx context.Context, id Identity, _ []json.RawMessage) (any, error) {
		if id.Role != "admin" {
			return nil, errNotAdmin
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		resp, err := client.ListTeams(ctx, &tenantv1.ListTeamsRequest{})
		if err != nil {
			return nil, err
		}
		return resp.GetTeams(), nil
	})

	r.Register("team.addMember", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		if id.Role != "admin" {
			return nil, errNotAdmin
		}
		type addMemberArgs struct {
			TeamID string `json:"teamId"`
			UserID string `json:"userId"`
			// Role has nowhere to go — AddTeamMemberRequest carries only
			// priority, role defaults to 'member' server-side (README
			// "Known gaps", cited by BUG-028). Decoded and silently dropped
			// here rather than erroring, matching this file's existing
			// best-effort convention (channels.go:6-14).
			Role     string `json:"role"`
			Priority int32  `json:"priority"`
		}
		in, err := decodeArg[addMemberArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		if _, err := client.AddTeamMember(ctx, &tenantv1.AddTeamMemberRequest{
			TeamId: in.TeamID, UserId: in.UserID, Priority: in.Priority,
		}); err != nil {
			return nil, err
		}
		return map[string]bool{"ok": true}, nil
	})

	r.Register("team.removeMember", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		if id.Role != "admin" {
			return nil, errNotAdmin
		}
		type removeMemberArgs struct {
			TeamID string `json:"teamId"`
			UserID string `json:"userId"`
		}
		in, err := decodeArg[removeMemberArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		if _, err := client.RemoveTeamMember(ctx, &tenantv1.RemoveTeamMemberRequest{
			TeamId: in.TeamID, UserId: in.UserID,
		}); err != nil {
			return nil, err
		}
		return map[string]bool{"ok": true}, nil
	})

	r.Register("team.listMembers", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		if id.Role != "admin" {
			return nil, errNotAdmin
		}
		type listMembersArgs struct {
			TeamID string `json:"teamId"`
		}
		in, err := decodeArg[listMembersArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		resp, err := client.ListTeamMembers(ctx, &tenantv1.ListTeamMembersRequest{TeamId: in.TeamID})
		if err != nil {
			return nil, err
		}
		return resp.GetMembers(), nil
	})
}
