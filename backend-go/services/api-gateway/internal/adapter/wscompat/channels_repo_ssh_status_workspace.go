// This file holds the repo.*/ssh.*/status.get/workspacePorts.* channel
// registrations added for SOL-023/SOL-024/SOL-025/SOL-027
// (specs/backend-go/bugs/missing-v1). Deliberately kept OUT of channels.go —
// another group is concurrently extending that file's registerGitChannels/
// RegisterRealChannels for git.*/files.* work, and merging two sets of
// hand-edits to the same function bodies is exactly the kind of conflict a
// separate file avoids. See this file's bottom doc comment for the
// one-line wiring RegisterRealChannels/main.go still need once this file's
// registerRepoSshStatusWorkspaceChannels is folded in.
//
// workspace.refreshFileTree (TASK-168/SOL-026) is NOT implemented here — it
// wraps a files.* RPC that does not exist yet in this worktree (see
// specs/backend-go/bugs/missing-v1/tasks/TASK-168-wire-workspace-refresh-file-tree.md,
// marked [blocked] in this pass). Wiring it before files.* lands would mean
// inventing a throwaway parallel directory-listing RPC — do not do that.
package wscompat

import (
	"context"
	"encoding/json"
	"fmt"
	"runtime"
	"time"

	gitgatewayv1 "github.com/stablyai/orca-go/proto/gen/go/orca/gitgateway/v1"
	infrafleetv1 "github.com/stablyai/orca-go/proto/gen/go/orca/infrafleet/v1"
	projectv1 "github.com/stablyai/orca-go/proto/gen/go/orca/project/v1"

	gatewaygrpc "github.com/stablyai/orca-go/services/api-gateway/internal/adapter/grpc"
	"github.com/stablyai/orca-go/services/api-gateway/internal/usecase"
)

// repoSSHStatusWorkspaceRPCTimeout mirrors the rpcTimeout convention
// TASK-151/154/160/165/167/169/172's design already assumes exists in
// channels.go (it doesn't yet, in this worktree's current state) — named
// distinctly here so this file compiles standalone and doesn't collide with
// whatever name the integration pass's merge settles on.
const repoSSHStatusWorkspaceRPCTimeout = 8 * time.Second

// registerRepoSshStatusWorkspaceChannels wires every repo.*/ssh.*/
// status.get/workspacePorts.* channel this pass gives real backend-go
// implementations to. NOT called from RegisterRealChannels yet — see this
// file's bottom doc comment for the one-line wiring the integration pass
// needs to fold this in.
func registerRepoSshStatusWorkspaceChannels(
	r *Registry,
	project projectv1.ProjectServiceClient,
	git gitgatewayv1.GitGatewayServiceClient,
	infraFleet infrafleetv1.InfraFleetServiceClient,
) {
	registerRepoChannels(r, project, git)
	registerSshChannels(r, infraFleet)
	registerStatusChannels(r)
	registerWorkspacePortsChannels(r, project, infraFleet)
}

// repoView/toRepoView: same camelCase-view fix as channels_tenant_project.go
// (see that file's projectView doc comment for the full reasoning) —
// projectv1.Repo's project_id is snake_case on the wire via plain
// encoding/json, but shared/types.ts's Repo needs projectId (4b-4 threads
// it through so per-repo actions know their owning project without a
// second lookup).
type repoView struct {
	ID          string `json:"id"`
	ProjectID   string `json:"projectId"`
	URL         string `json:"url"`
	DisplayName string `json:"displayName"`
	Position    int32  `json:"position"`
	// DevServerID (Phase 10): this repo's own dev-server binding, empty =
	// local. Previously only resolvable via the owning project.
	DevServerID string `json:"devServerId"`
	// HookSettings: opaque JSON blob (frontend's RepoHookSettings shape),
	// empty = never set. See project.proto's Repo.hook_settings doc comment.
	HookSettings string `json:"hookSettings"`
}

func toRepoView(r *projectv1.Repo) repoView {
	return repoView{
		ID: r.GetId(), ProjectID: r.GetProjectId(), URL: r.GetUrl(),
		DisplayName: r.GetDisplayName(), Position: r.GetPosition(),
		DevServerID:  r.GetDevServerId(),
		HookSettings: r.GetHookSettings(),
	}
}

// cloneResultView/initRepoResultView: git-gateway-service's CloneResponse/
// InitRepoResponse have their own default_branch snake_case field — same
// bug, same fix, one level removed (a different backend service's proto
// package, not project-service's).
type cloneResultView struct {
	WorktreePath  string `json:"worktreePath"`
	DefaultBranch string `json:"defaultBranch"`
}

type initRepoResultView struct {
	Path          string `json:"path"`
	DefaultBranch string `json:"defaultBranch"`
	RemoteAdded   bool   `json:"remoteAdded"`
}

// ── repo.* ───────────────────────────────────────────────────────────────
//
// repo.add/list/reorder/rm/update map 1:1 onto ProjectService's
// AddRepo/ListRepos/ReorderRepos/RemoveRepo/UpdateRepo — pure catalog CRUD
// against the repos Postgres table, per project-service.md §4's "Repo —
// pure metadata, no working-tree state." The remaining 8 (clone,
// baseRefDefault, searchRefs, create, hooksCheck, issueCommandRead,
// issueCommandWrite, setupScriptImports) are file/host operations against a
// repo's working tree, so they dispatch to git-gateway-service instead —
// see SOL-023 Bucket 3.
func registerRepoChannels(r *Registry, project projectv1.ProjectServiceClient, git gitgatewayv1.GitGatewayServiceClient) {
	r.Register("repo.add", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type addArgs struct {
			ProjectID   string `json:"projectId"`
			URL         string `json:"url"`
			DisplayName string `json:"displayName"`
			// DevServerID (Phase 10): empty = local repo, validated against
			// infra-fleet server-side when non-empty.
			DevServerID string `json:"devServerId"`
		}
		in, err := decodeArg[addArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, repoSSHStatusWorkspaceRPCTimeout)
		defer cancel()
		resp, err := project.AddRepo(rpcCtx, &projectv1.AddRepoRequest{
			ProjectId: in.ProjectID, Url: in.URL, DisplayName: in.DisplayName, DevServerId: in.DevServerID,
		})
		if err != nil {
			return nil, err
		}
		return toRepoView(resp.GetRepo()), nil
	})

	// repo.rebindDevServer (Phase 10) — repo-scoped replacement for
	// project.rebindDevServer (channels_tenant_project.go), now that
	// dev-server ownership lives on Repo, not Project.
	r.Register("repo.rebindDevServer", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type rebindArgs struct {
			RepoID         string `json:"repoId"`
			NewDevServerID string `json:"newDevServerId"`
		}
		in, err := decodeArg[rebindArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, repoSSHStatusWorkspaceRPCTimeout)
		defer cancel()
		resp, err := project.RebindRepoDevServer(rpcCtx, &projectv1.RebindRepoDevServerRequest{
			RepoId: in.RepoID, NewDevServerId: in.NewDevServerID,
		})
		if err != nil {
			return nil, err
		}
		return toRepoView(resp.GetRepo()), nil
	})

	r.Register("repo.list", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type listArgs struct {
			ProjectID string `json:"projectId"`
		}
		in, err := decodeArg[listArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, repoSSHStatusWorkspaceRPCTimeout)
		defer cancel()
		resp, err := project.ListRepos(rpcCtx, &projectv1.ListReposRequest{ProjectId: in.ProjectID})
		if err != nil {
			return nil, err
		}
		// Wrapped in {repos: [...]}, NOT a bare array — both call sites
		// (frontend/src/renderer/src/web/web-preload-api.ts's repos.list AND
		// its repo.list-for-a-runtime-environment path) do
		// `(await callRuntimeResult<{ repos: Repo[] }>('repo.list')).repos`,
		// matching the old TS backend's repo.ts handler:
		// `return { repos: runtime.listRepos() }`. A bare array has no
		// `.repos` property, so that destructure silently produced
		// `undefined` — surfaced as "[repos] repo.list returned a non-array
		// payload ... undefined" once the PROJECT_MEMBERSHIP_LOOKUP_FAILED
		// bug (fixed separately) stopped masking it.
		repos := resp.GetRepos()
		views := make([]repoView, 0, len(repos))
		for _, repo := range repos {
			views = append(views, toRepoView(repo))
		}
		return map[string]any{"repos": views}, nil
	})

	r.Register("repo.reorder", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type reorderArgs struct {
			ProjectID      string   `json:"projectId"`
			RepoIDsInOrder []string `json:"repoIdsInOrder"`
		}
		in, err := decodeArg[reorderArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, repoSSHStatusWorkspaceRPCTimeout)
		defer cancel()
		_, err = project.ReorderRepos(rpcCtx, &projectv1.ReorderReposRequest{
			ProjectId: in.ProjectID, RepoIdsInOrder: in.RepoIDsInOrder,
		})
		return nil, err
	})

	r.Register("repo.rm", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type rmArgs struct {
			RepoID string `json:"repoId"`
		}
		in, err := decodeArg[rmArgs](args, 0)
		if err != nil {
			return nil, err
		}
		// NOTE: RemoveRepo does NOT detach worktrees first —
		// project-service.md §3's comment on RemoveRepoRequest ("caller
		// must detach worktrees via git-gateway-service first") means this
		// handler, or the frontend action that calls it, is responsible
		// for that ordering. Flag as a follow-up if the frontend doesn't
		// already enforce it.
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, repoSSHStatusWorkspaceRPCTimeout)
		defer cancel()
		_, err = project.RemoveRepo(rpcCtx, &projectv1.RemoveRepoRequest{RepoId: in.RepoID})
		return nil, err
	})

	r.Register("repo.update", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type updateArgs struct {
			RepoID       string  `json:"repoId"`
			URL          string  `json:"url"`
			DisplayName  string  `json:"displayName"`
			// *string (not string): explicit presence, matching
			// UpdateRepoRequest.hook_settings' proto3 `optional` — a
			// present-but-empty value (`""`) is a real "clear it" request,
			// distinct from the field being absent ("don't touch it").
			// encoding/json leaves this nil when the key is missing or null.
			HookSettings *string `json:"hookSettings"`
		}
		in, err := decodeArg[updateArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, repoSSHStatusWorkspaceRPCTimeout)
		defer cancel()
		resp, err := project.UpdateRepo(rpcCtx, &projectv1.UpdateRepoRequest{
			RepoId: in.RepoID, Url: in.URL, DisplayName: in.DisplayName, HookSettings: in.HookSettings,
		})
		if err != nil {
			return nil, err
		}
		return toRepoView(resp.GetRepo()), nil
	})

	// repo.assignToProject moves an EXISTING repo into a different project —
	// Project Settings' "Repos" tab candidate picker (attach an
	// already-known repo to an OrcaProject), distinct from repo.add/create
	// (always creates a brand-new repo).
	r.Register("repo.assignToProject", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type assignArgs struct {
			RepoID          string `json:"repoId"`
			TargetProjectID string `json:"targetProjectId"`
		}
		in, err := decodeArg[assignArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, repoSSHStatusWorkspaceRPCTimeout)
		defer cancel()
		resp, err := project.AssignRepoToProject(rpcCtx, &projectv1.AssignRepoToProjectRequest{
			RepoId: in.RepoID, TargetProjectId: in.TargetProjectID,
		})
		if err != nil {
			return nil, err
		}
		return toRepoView(resp.GetRepo()), nil
	})

	// repo.getMembers/addMember/removeMember/updateMemberRole map 1:1 onto
	// ProjectService's ListRepoMembers/AddRepoMember/RemoveRepoMember/
	// UpdateRepoMemberRole — the repo-scoped functional-role tier
	// (developer/lead/admin), layered on top of project.getMembers/
	// addMember/removeMember/updateMemberRole's project-level owner/member
	// tier (channels_tenant_project.go). See policy/orca-authz/repo.rego.
	r.Register("repo.getMembers", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type getArgs struct {
			RepoID string `json:"repoId"`
		}
		in, err := decodeArg[getArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, repoSSHStatusWorkspaceRPCTimeout)
		defer cancel()
		resp, err := project.ListRepoMembers(rpcCtx, &projectv1.ListRepoMembersRequest{RepoId: in.RepoID})
		if err != nil {
			return nil, err
		}
		out := make([]repoMemberView, 0, len(resp.GetMembers()))
		for _, m := range resp.GetMembers() {
			out = append(out, toRepoMemberView(m))
		}
		return out, nil
	})

	r.Register("repo.addMember", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type addArgs struct {
			RepoID string `json:"repoId"`
			UserID string `json:"userId"`
			Role   string `json:"role"`
		}
		in, err := decodeArg[addArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, repoSSHStatusWorkspaceRPCTimeout)
		defer cancel()
		resp, err := project.AddRepoMember(rpcCtx, &projectv1.AddRepoMemberRequest{
			RepoId: in.RepoID, UserId: in.UserID, Role: toRepoRoleArg(in.Role),
		})
		if err != nil {
			return nil, err
		}
		return toRepoMemberView(resp.GetMember()), nil
	})

	r.Register("repo.removeMember", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type removeArgs struct {
			RepoID string `json:"repoId"`
			UserID string `json:"userId"`
		}
		in, err := decodeArg[removeArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, repoSSHStatusWorkspaceRPCTimeout)
		defer cancel()
		if _, err := project.RemoveRepoMember(rpcCtx, &projectv1.RemoveRepoMemberRequest{
			RepoId: in.RepoID, UserId: in.UserID,
		}); err != nil {
			return nil, err
		}
		return map[string]bool{"ok": true}, nil
	})

	r.Register("repo.updateMemberRole", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type updateArgs struct {
			RepoID string `json:"repoId"`
			UserID string `json:"userId"`
			Role   string `json:"role"`
		}
		in, err := decodeArg[updateArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, repoSSHStatusWorkspaceRPCTimeout)
		defer cancel()
		resp, err := project.UpdateRepoMemberRole(rpcCtx, &projectv1.UpdateRepoMemberRoleRequest{
			RepoId: in.RepoID, UserId: in.UserID, Role: toRepoRoleArg(in.Role),
		})
		if err != nil {
			return nil, err
		}
		return toRepoMemberView(resp.GetMember()), nil
	})

	// sparsePresets.list/save/remove map 1:1 onto ProjectService's
	// ListSparsePresets/SaveSparsePreset/RemoveSparsePreset — saved directory
	// sets for sparse worktree creation, scoped to one repo. Closes a
	// genuine feature gap (not a wiring bug like most of this file): these
	// RPCs didn't exist in backend-go at all before this pass — confirmed
	// live on b15.openledger.vn, Project Settings > Repos tab logging
	// "channel \"sparsePresets.list\" is not yet implemented in backend-go".
	// Ports backend/src/main/runtime/rpc/methods/sparse-presets.ts (legacy
	// TS reference); its `sparsePresets.subscribeChanged` streaming method
	// is NOT ported here — no push-update UI consumer exists yet
	// (SparsePresetSettingsSection.tsx only ever polls via a plain fetch on
	// mount), so it would be speculative surface with nothing to verify
	// against.
	r.Register("sparsePresets.list", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type listArgs struct {
			RepoID string `json:"repoId"`
		}
		in, err := decodeArg[listArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, repoSSHStatusWorkspaceRPCTimeout)
		defer cancel()
		resp, err := project.ListSparsePresets(rpcCtx, &projectv1.ListSparsePresetsRequest{RepoId: in.RepoID})
		if err != nil {
			return nil, err
		}
		out := make([]sparsePresetView, 0, len(resp.GetPresets()))
		for _, p := range resp.GetPresets() {
			out = append(out, toSparsePresetView(p))
		}
		return out, nil
	})

	r.Register("sparsePresets.save", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type saveArgs struct {
			RepoID      string   `json:"repoId"`
			ID          string   `json:"id"`
			Name        string   `json:"name"`
			Directories []string `json:"directories"`
		}
		in, err := decodeArg[saveArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, repoSSHStatusWorkspaceRPCTimeout)
		defer cancel()
		resp, err := project.SaveSparsePreset(rpcCtx, &projectv1.SaveSparsePresetRequest{
			RepoId: in.RepoID, Id: in.ID, Name: in.Name, Directories: in.Directories,
		})
		if err != nil {
			return nil, err
		}
		return toSparsePresetView(resp.GetPreset()), nil
	})

	r.Register("sparsePresets.remove", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type removeArgs struct {
			RepoID   string `json:"repoId"`
			PresetID string `json:"presetId"`
		}
		in, err := decodeArg[removeArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, repoSSHStatusWorkspaceRPCTimeout)
		defer cancel()
		if _, err := project.RemoveSparsePreset(rpcCtx, &projectv1.RemoveSparsePresetRequest{
			RepoId: in.RepoID, PresetId: in.PresetID,
		}); err != nil {
			return nil, err
		}
		return map[string]bool{"ok": true}, nil
	})

	r.Register("repo.clone", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type cloneArgs struct {
			DevServerID string `json:"devServerId"`
			URL         string `json:"url"`
			DestPath    string `json:"destPath"`
		}
		in, err := decodeArg[cloneArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		// Longer-than-default deadline: cloning a real repo, especially
		// relayed to a remote host, can legitimately exceed the default 8s.
		// Same reasoning as ssh.connect's 20s override (SOL-024).
		rpcCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
		defer cancel()
		resp, err := git.Clone(rpcCtx, &gitgatewayv1.CloneRequest{
			DevServerId: in.DevServerID, Url: in.URL, DestPath: in.DestPath,
		})
		if err != nil {
			return nil, err
		}
		return cloneResultView{WorktreePath: resp.GetWorktreePath(), DefaultBranch: resp.GetDefaultBranch()}, nil
	})

	r.Register("repo.baseRefDefault", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		// repoId, not worktreeId: this channel is called from repo-scoped
		// contexts (Settings, SourceControl's default-branch hint) that have
		// no worktree id — git-gateway-service's BaseRefDefault usecase
		// dispatches via repo id (dispatchExecutorForRepo), see its own doc
		// comment.
		type baseRefDefaultArgs struct {
			RepoID string `json:"repoId"`
		}
		in, err := decodeArg[baseRefDefaultArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, repoSSHStatusWorkspaceRPCTimeout)
		defer cancel()
		resp, err := git.BaseRefDefault(rpcCtx, &gitgatewayv1.BaseRefDefaultRequest{RepoId: in.RepoID})
		if err != nil {
			return nil, err
		}
		return resp, nil
	})

	r.Register("repo.searchRefs", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		// repoId, not worktreeId — same reasoning as repo.baseRefDefault above.
		type searchRefsArgs struct {
			RepoID string `json:"repoId"`
			Query  string `json:"query"`
		}
		in, err := decodeArg[searchRefsArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, repoSSHStatusWorkspaceRPCTimeout)
		defer cancel()
		resp, err := git.SearchRefs(rpcCtx, &gitgatewayv1.SearchRefsRequest{RepoId: in.RepoID, Query: in.Query})
		if err != nil {
			return nil, err
		}
		return resp, nil
	})

	r.Register("repo.create", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type createArgs struct {
			DevServerID   string `json:"devServerId"`
			DestPath      string `json:"destPath"`
			DefaultBranch string `json:"defaultBranch"`
			// RemoteURL/RemoteName: "Initialize as Git repo" feature's
			// optional second step — empty RemoteURL = no remote added.
			RemoteURL  string `json:"remoteUrl"`
			RemoteName string `json:"remoteName"`
		}
		in, err := decodeArg[createArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, repoSSHStatusWorkspaceRPCTimeout)
		defer cancel()
		resp, err := git.InitRepo(rpcCtx, &gitgatewayv1.InitRepoRequest{
			DevServerId: in.DevServerID, DestPath: in.DestPath, DefaultBranch: in.DefaultBranch,
			RemoteUrl: in.RemoteURL, RemoteName: in.RemoteName,
		})
		if err != nil {
			return nil, err
		}
		return initRepoResultView{
			Path: resp.GetPath(), DefaultBranch: resp.GetDefaultBranch(), RemoteAdded: resp.GetRemoteAdded(),
		}, nil
	})

	r.Register("repo.hooksCheck", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		// repo, not worktreeId: this channel is called from repo-scoped
		// contexts (Settings' Worktree Hooks section) that have no worktree
		// id — git-gateway-service's CheckHooks usecase dispatches via repo
		// id (dispatchExecutorForRepo), see its own doc comment. "repo" (not
		// "repoId") matches runtime-hooks-client.ts's existing wire shape,
		// shared with the desktop-local repo.hooksCheck handler.
		type hooksCheckArgs struct {
			Repo string `json:"repo"`
		}
		in, err := decodeArg[hooksCheckArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, repoSSHStatusWorkspaceRPCTimeout)
		defer cancel()
		resp, err := git.CheckHooks(rpcCtx, &gitgatewayv1.CheckHooksRequest{RepoId: in.Repo})
		if err != nil {
			return nil, err
		}
		return resp, nil
	})

	r.Register("repo.issueCommandRead", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		// repo, not worktreeId — same reasoning as repo.hooksCheck above.
		type issueCommandReadArgs struct {
			Repo string `json:"repo"`
		}
		in, err := decodeArg[issueCommandReadArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, repoSSHStatusWorkspaceRPCTimeout)
		defer cancel()
		resp, err := git.ReadIssueCommand(rpcCtx, &gitgatewayv1.ReadIssueCommandRequest{RepoId: in.Repo})
		if err != nil {
			return nil, err
		}
		return resp, nil
	})

	r.Register("repo.issueCommandWrite", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		// repo, not worktreeId — same reasoning as repo.hooksCheck above.
		type issueCommandWriteArgs struct {
			Repo    string `json:"repo"`
			Content string `json:"content"`
		}
		in, err := decodeArg[issueCommandWriteArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, repoSSHStatusWorkspaceRPCTimeout)
		defer cancel()
		_, err = git.WriteIssueCommand(rpcCtx, &gitgatewayv1.WriteIssueCommandRequest{RepoId: in.Repo, Content: in.Content})
		return nil, err
	})

	r.Register("repo.setupScriptImports", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		// repo, not worktreeId — same reasoning as repo.hooksCheck above.
		type setupScriptImportsArgs struct {
			Repo string `json:"repo"`
		}
		in, err := decodeArg[setupScriptImportsArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, repoSSHStatusWorkspaceRPCTimeout)
		defer cancel()
		resp, err := git.ScanSetupScriptImports(rpcCtx, &gitgatewayv1.ScanSetupScriptImportsRequest{RepoId: in.Repo})
		if err != nil {
			return nil, err
		}
		return resp, nil
	})
}

// ── ssh.* ────────────────────────────────────────────────────────────────
//
// ssh.getUserAccount in the old backend was never a distinct "Linux account
// provisioning" concept — it just read the target's configured username, so
// it derives from ListSshTargets client-side rather than getting its own
// RPC.
func registerSshChannels(r *Registry, client infrafleetv1.InfraFleetServiceClient) {
	r.Register("ssh.listTargets", func(ctx context.Context, id Identity, _ []json.RawMessage) (any, error) {
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, repoSSHStatusWorkspaceRPCTimeout)
		defer cancel()
		resp, err := client.ListSshTargets(rpcCtx, &infrafleetv1.ListSshTargetsRequest{})
		if err != nil {
			return nil, err
		}
		return resp.GetSshTargets(), nil
	})

	r.Register("ssh.getUserAccount", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type getUserAccountArgs struct {
			SshTargetID string `json:"sshTargetId"`
		}
		in, err := decodeArg[getUserAccountArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, repoSSHStatusWorkspaceRPCTimeout)
		defer cancel()
		resp, err := client.ListSshTargets(rpcCtx, &infrafleetv1.ListSshTargetsRequest{})
		if err != nil {
			return nil, err
		}
		for _, t := range resp.GetSshTargets() {
			if t.GetId() == in.SshTargetID {
				return map[string]string{"username": t.GetUser()}, nil
			}
		}
		return nil, fmt.Errorf("ssh target %q not found", in.SshTargetID)
	})

	r.Register("ssh.getState", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type getStateArgs struct {
			SshTargetID string `json:"sshTargetId"`
		}
		in, err := decodeArg[getStateArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, repoSSHStatusWorkspaceRPCTimeout)
		defer cancel()
		resp, err := client.GetSshState(rpcCtx, &infrafleetv1.GetSshStateRequest{SshTargetId: in.SshTargetID})
		if err != nil {
			return nil, err
		}
		return resp, nil
	})

	r.Register("ssh.connect", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type connectArgs struct {
			SshTargetID string `json:"sshTargetId"`
		}
		in, err := decodeArg[connectArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		// Longer-than-default deadline: this is an SSH handshake, not a
		// Postgres read — infra-fleet-service.md §8's "explicit timeout
		// distinct from the default 5s intra-cluster gRPC deadline" rule,
		// same reasoning as BootstrapFleetTarget's streaming RPC.
		rpcCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
		defer cancel()
		resp, err := client.EstablishConnection(rpcCtx, &infrafleetv1.EstablishConnectionRequest{SshTargetId: in.SshTargetID})
		if err != nil {
			return nil, err
		}
		return resp, nil
	})
}

// ── status.get ────────────────────────────────────────────────────────
//
// Registered as a fast, LOCAL (no downstream call) response, same pattern
// as registerPreflightChannels in channels.go — see SOL-025 for why:
// status.get's simplest caller (windows-terminal-capability-read.ts,
// target.kind==='local') reads nothing but hostPlatform.
//
// CORRECTED (see TASK-036's "Status by layer" section): this doc comment
// used to claim browser-pane-remote.tsx's target.kind==='environment' call
// path was Electron-desktop-only and out of scope for backend-go. That was
// wrong for the web/server-mode build api-gateway actually targets —
// window.api.runtimeEnvironments.call/subscribe DOES reach this package's
// /ws surface for a session-auth environment (WebSessionClient), proven by
// accounts.subscribe (TASK-023). capabilities now reports
// "browser.screencast.v1" for real, matching
// frontend/src/shared/protocol-version.ts's RUNTIME_CAPABILITIES entry —
// browser-pane-remote.tsx's capability gate
// (status.capabilities.includes('browser.screencast.v1')) checks exactly
// this before ever opening the browser.screencast subscription
// (channels_browser_screencast.go).
//
// runtimeId/graphStatus/authoritativeWindowId/liveTabCount/liveLeafCount
// mirror Electron's multi-window runtime-graph concept, which has no
// server-mode equivalent — reported as honest zero-values, not fabricated,
// matching preflight.check's gh/glab convention.
func registerStatusChannels(r *Registry) {
	r.Register("status.get", func(ctx context.Context, id Identity, _ []json.RawMessage) (any, error) {
		return map[string]any{
			"runtimeId":                         "api-gateway",
			"rendererGraphEpoch":                0,
			"graphStatus":                       "n/a", // no window/tab graph server-side
			"authoritativeWindowId":             nil,
			"liveTabCount":                      0,
			"liveLeafCount":                     0,
			"runtimeProtocolVersion":            currentRuntimeProtocolVersion,
			"minCompatibleRuntimeClientVersion": minCompatibleRuntimeClientVersion,
			"capabilities":                      []string{"browser.screencast.v1"},
			"hostPlatform":                      hostPlatformString(), // the one field windows-terminal-capability-read.ts actually reads
		}, nil
	})
}

// currentRuntimeProtocolVersion/minCompatibleRuntimeClientVersion should
// match frontend/src/shared/protocol-version.ts's RUNTIME_PROTOCOL_VERSION/
// MIN_COMPATIBLE_RUNTIME_SERVER_VERSION constants at implementation time —
// check that file's current values rather than trusting this hardcoded
// number to stay in sync.
const (
	currentRuntimeProtocolVersion     = 3
	minCompatibleRuntimeClientVersion = 2
)

// hostPlatformString reports runtime.GOOS translated to match
// RuntimeStatus.hostPlatform's frontend type (NodeJS.Platform:
// 'win32' | 'darwin' | 'linux' | ...) — runtime.GOOS already matches on
// darwin/linux; only "windows" needs translating to "win32".
func hostPlatformString() string {
	if runtime.GOOS == "windows" {
		return "win32"
	}
	return runtime.GOOS
}

// ── workspacePorts.* ─────────────────────────────────────────────────────
//
// scan calls the already-implemented ScanWorkspacePorts (infrafleet.proto) —
// closes TS Gap 7, see scan_workspace_ports.go's doc comment: always
// resolves the connection first, relays to the agent's ports.scan when
// connectionId is bound, only returns [] for a genuinely unconnected
// worktree. kill calls the new KillWorkspacePort RPC (TASK-170/171),
// following the exact same resolve-then-dispatch shape.
//
// BUG-016 fix: the frontend's killWorkspacePortForTarget/scan call sites
// pass {repoId, worktreeId?, pid, port}/{repoId} (workspace-port-actions.ts),
// never {connectionId, worktreeId} directly — repoId (and, for kill,
// worktreeId) needs resolving to a connectionId before calling these RPCs.
// Both handlers now resolve in this priority order:
//  1. worktreeId, if given directly (unambiguous — resolved via
//     resolveConnectionIDForWorktree, the same ResolveConnection(worktree_id=)
//     helper channels_ephemeral_vm.go/channels_browser.go already use). kill's
//     wire contract now carries worktreeId when the frontend has one at hand
//     (WorkspacePort.owner.worktreeId is already known at every real kill call
//     site — see workspace-port-actions.ts's workspacePortOwnerWorktreeId),
//     which is strictly more precise than any repoId-based guess.
//  2. otherwise, repoId — resolved server-side via
//     resolveWorkspacePortsConnectionForRepo: GetRepo(repoId) for its
//     project_id, then ListWorktrees(project_id) filtered to this repo's
//     worktrees. A repo can have zero, one, or several worktrees, and
//     ListWorktreesRequest has no repo_id filter of its own (see
//     channels_worktree.go's worktree.list NOTE) — this handler does that
//     filter itself. Exactly one ACTIVE worktree for the repo resolves
//     unambiguously; zero or multiple active worktrees is genuinely
//     ambiguous from repoId alone (no signal here says which one the
//     caller means), so it degrades to the pre-existing safe no-op
//     (empty connectionId) rather than guessing — matching
//     scan_workspace_ports.go/kill_workspace_port.go's own
//     empty-ConnectionID-is-a-valid-input contract. A single non-active
//     worktree still resolves (mirrors workspace.refreshFileTree's
//     "fall back to the only worktree" convention).
//
// Verified against ListWorktreesResponse's real Worktree.active semantics
// (project.proto's Worktree.active, project-service's activation model) —
// not merely assumed "at most one active worktree per repo" as this bug's
// own filed report flagged as unverified: multiple active worktrees per repo
// ARE possible (independent per-worktree activation), so the ambiguous case
// above is a real, not theoretical, branch.
func registerWorkspacePortsChannels(r *Registry, project projectv1.ProjectServiceClient, client infrafleetv1.InfraFleetServiceClient) {
	r.Register("workspacePorts.scan", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type scanArgs struct {
			ConnectionID string `json:"connectionId"`
			WorktreeID   string `json:"worktreeId"`
			RepoID       string `json:"repoId"`
		}
		in, err := decodeArg[scanArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, repoSSHStatusWorkspaceRPCTimeout)
		defer cancel()
		connectionID, worktreeID, err := resolveWorkspacePortsConnection(
			rpcCtx, project, client, in.ConnectionID, in.WorktreeID, in.RepoID,
		)
		if err != nil {
			return nil, err
		}
		resp, err := client.ScanWorkspacePorts(rpcCtx, &infrafleetv1.ScanWorkspacePortsRequest{
			ConnectionId: connectionID,
			WorktreeId:   worktreeID,
		})
		if err != nil {
			return nil, err
		}
		return toWorkspacePortScanResult(resp.GetOpenPorts()), nil
	})

	r.Register("workspacePorts.kill", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type killArgs struct {
			ConnectionID string `json:"connectionId"`
			WorktreeID   string `json:"worktreeId"`
			RepoID       string `json:"repoId"`
			PID          int32  `json:"pid"`
			Port         int32  `json:"port"`
		}
		in, err := decodeArg[killArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, repoSSHStatusWorkspaceRPCTimeout)
		defer cancel()
		connectionID, worktreeID, err := resolveWorkspacePortsConnection(
			rpcCtx, project, client, in.ConnectionID, in.WorktreeID, in.RepoID,
		)
		if err != nil {
			return nil, err
		}
		resp, err := client.KillWorkspacePort(rpcCtx, &infrafleetv1.KillWorkspacePortRequest{
			ConnectionId: connectionID, WorktreeId: worktreeID, Pid: in.PID, Port: in.Port,
		})
		if err != nil {
			return nil, err
		}
		if !resp.GetOk() {
			return map[string]any{"ok": false, "reason": resp.GetReason()}, nil
		}
		return map[string]any{"ok": true}, nil
	})
}

// resolveWorkspacePortsConnection resolves workspacePorts.scan/kill's
// {connectionId, worktreeId, repoId} arg trio down to a single
// (connectionId, worktreeId) pair to send to infra-fleet-service, per
// registerWorkspacePortsChannels' doc comment. explicitConnectionID passing
// through unresolved (never overridden) lets an already-correct direct call
// keep working exactly as before.
func resolveWorkspacePortsConnection(
	ctx context.Context,
	project projectv1.ProjectServiceClient,
	infra infrafleetv1.InfraFleetServiceClient,
	explicitConnectionID, explicitWorktreeID, repoID string,
) (connectionID, worktreeID string, err error) {
	if explicitConnectionID != "" {
		return explicitConnectionID, explicitWorktreeID, nil
	}
	if explicitWorktreeID != "" {
		connID, err := resolveConnectionIDForWorktree(ctx, infra, explicitWorktreeID)
		if err != nil {
			return "", "", err
		}
		return connID, explicitWorktreeID, nil
	}
	if repoID == "" {
		return "", "", nil
	}
	resolvedWorktreeID, err := resolveWorktreeIDForRepo(ctx, project, repoID)
	if err != nil {
		return "", "", err
	}
	if resolvedWorktreeID == "" {
		return "", "", nil
	}
	connID, err := resolveConnectionIDForWorktree(ctx, infra, resolvedWorktreeID)
	if err != nil {
		return "", "", err
	}
	return connID, resolvedWorktreeID, nil
}

// resolveWorktreeIDForRepo finds repoID's single unambiguous worktree, or
// "" when there isn't one (no worktrees, or the active-worktree count for
// this repo isn't exactly one) — see registerWorkspacePortsChannels' doc
// comment for why zero/multiple active worktrees degrades to "" rather than
// guessing. GetRepo failing (e.g. repoID doesn't exist) is a real error,
// propagated rather than swallowed into "".
func resolveWorktreeIDForRepo(ctx context.Context, project projectv1.ProjectServiceClient, repoID string) (string, error) {
	repoResp, err := project.GetRepo(ctx, &projectv1.GetRepoRequest{RepoId: repoID})
	if err != nil {
		return "", err
	}
	projectID := repoResp.GetRepo().GetProjectId()
	if projectID == "" {
		return "", nil
	}
	wtResp, err := project.ListWorktrees(ctx, &projectv1.ListWorktreesRequest{ProjectId: projectID})
	if err != nil {
		return "", err
	}
	var active, all []*projectv1.Worktree
	for _, w := range wtResp.GetWorktrees() {
		if w.GetRepoId() != repoID {
			continue
		}
		all = append(all, w)
		if w.GetActive() {
			active = append(active, w)
		}
	}
	if len(active) == 1 {
		return active[0].GetId(), nil
	}
	if len(active) == 0 && len(all) == 1 {
		return all[0].GetId(), nil
	}
	// Zero worktrees, or more than one active worktree for this repo:
	// genuinely ambiguous from repoId alone — no-op rather than guess.
	return "", nil
}

// toWorkspacePortScanResult maps ScanWorkspacePortsResponse's []int32 open
// ports onto the frontend's WorkspacePortScanResult{platform, scannedAt,
// ports, unavailableReason?} shape (frontend/src/shared/workspace-ports.ts)
// — platform reported as "unknown" (this service never inspects the target
// host's OS) and unavailableReason left empty on success, honest-placeholder
// convention.
func toWorkspacePortScanResult(openPorts []int32) map[string]any {
	return map[string]any{
		"platform":  "unknown",
		"scannedAt": time.Now().UnixMilli(),
		"ports":     openPorts,
	}
}

// toRepoRoleArg maps the wscompat wire arg's repo-role string
// ("developer" | "lead" | "admin") onto projectv1.RepoRole — mirrors
// channels_tenant_project.go's toProjectRoleArg for the same kind of
// string-to-enum wire mapping, one tier down.
func toRepoRoleArg(role string) projectv1.RepoRole {
	switch role {
	case "developer":
		return projectv1.RepoRole_REPO_ROLE_DEVELOPER
	case "lead":
		return projectv1.RepoRole_REPO_ROLE_LEAD
	case "admin":
		return projectv1.RepoRole_REPO_ROLE_ADMIN
	default:
		return projectv1.RepoRole_REPO_ROLE_UNSPECIFIED
	}
}

// fromRepoRoleArg is toRepoRoleArg's inverse — for the response side.
func fromRepoRoleArg(role projectv1.RepoRole) string {
	switch role {
	case projectv1.RepoRole_REPO_ROLE_DEVELOPER:
		return "developer"
	case projectv1.RepoRole_REPO_ROLE_LEAD:
		return "lead"
	case projectv1.RepoRole_REPO_ROLE_ADMIN:
		return "admin"
	default:
		return ""
	}
}

// repoMemberView is repo.getMembers/addMember/updateMemberRole's wire shape
// — {userId, role}, matching RepoMemberManager.tsx's RepoMember type
// exactly. Needed because projectv1.RepoMember (the raw proto struct) was
// being returned directly: its Role field is a protobuf enum (RepoRole
// int32 under the hood, no custom MarshalJSON), so plain encoding/json
// serializes it as a raw NUMBER, not the "developer"/"lead"/"admin" string
// the frontend's <Select> compares against — confirmed live on
// b15.openledger.vn as a permanently-blank Role column (every SelectItem's
// string value fails to match the numeric member.role).
type repoMemberView struct {
	UserID string `json:"userId"`
	Role   string `json:"role"`
}

func toRepoMemberView(m *projectv1.RepoMember) repoMemberView {
	return repoMemberView{UserID: m.GetUserId(), Role: fromRepoRoleArg(m.GetRole())}
}

// sparsePresetView is sparsePresets.list/save's wire shape — matches
// shared/types.ts's SparsePreset exactly (createdAt/updatedAt as epoch-ms
// numbers, per that legacy reference type, not proto Timestamps).
type sparsePresetView struct {
	ID          string   `json:"id"`
	RepoID      string   `json:"repoId"`
	Name        string   `json:"name"`
	Directories []string `json:"directories"`
	CreatedAt   int64    `json:"createdAt"`
	UpdatedAt   int64    `json:"updatedAt"`
}

func toSparsePresetView(p *projectv1.SparsePreset) sparsePresetView {
	return sparsePresetView{
		ID: p.GetId(), RepoID: p.GetRepoId(), Name: p.GetName(), Directories: p.GetDirectories(),
		CreatedAt: protoTimeMillis(p.GetCreatedAt()), UpdatedAt: protoTimeMillis(p.GetUpdatedAt()),
	}
}

// ─────────────────────────────────────────────────────────────────────────
// Integration TODO — the one-line wiring this file deliberately does NOT
// do itself (channels.go is off-limits to this pass, see this file's top
// doc comment):
//
//  1. In channels.go's RegisterRealChannels, add a `projectClient
//     projectv1.ProjectServiceClient` parameter (main.go already dials
//     project-service — see projectClient at main.go's composition root)
//     and call:
//
//       registerRepoSshStatusWorkspaceChannels(r, projectClient, gitClient, infraFleetClient)
//
//  2. In cmd/server/main.go, thread projectClient into the
//     RegisterRealChannels(...) call site alongside the existing
//     annotationClient/taskClient/gitClient/automationClient/infraFleetClient
//     arguments.
//
// No new gRPC client dials are needed for either step — projectClient and
// infraFleetClient are already constructed in main.go's composition root.
// ─────────────────────────────────────────────────────────────────────────
