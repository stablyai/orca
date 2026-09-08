// Package wscompat — ephemeralVm.* channels (SOL-004 Group 1: recipe/runtime
// reads only — attach/suspend/resume/cleanup are TASK-005; the ssh-result
// lifecycle is permanently blocked, see TASK-006).
package wscompat

import (
	"context"
	"encoding/json"
	"fmt"

	"google.golang.org/protobuf/types/known/timestamppb"

	gitgatewayv1 "github.com/stablyai/orca-go/proto/gen/go/orca/gitgateway/v1"
	infrafleetv1 "github.com/stablyai/orca-go/proto/gen/go/orca/infrafleet/v1"
	projectv1 "github.com/stablyai/orca-go/proto/gen/go/orca/project/v1"

	gatewaygrpc "github.com/stablyai/orca-go/services/api-gateway/internal/adapter/grpc"
	"github.com/stablyai/orca-go/services/api-gateway/internal/usecase"
)

type ephemeralVmRecipeView struct {
	ID              string `json:"id"`
	Name            string `json:"name"`
	Description     string `json:"description,omitempty"`
	Create          string `json:"create"`
	Suspend         string `json:"suspend,omitempty"`
	Resume          string `json:"resume,omitempty"`
	Destroy         string `json:"destroy,omitempty"`
	DestroyDisabled bool   `json:"destroyDisabled,omitempty"`
}

func toEphemeralVmRecipeView(r *gitgatewayv1.EphemeralVmRecipe) ephemeralVmRecipeView {
	return ephemeralVmRecipeView{
		ID: r.GetId(), Name: r.GetName(), Description: r.GetDescription(),
		Create: r.GetCreate(), Suspend: r.GetSuspend(), Resume: r.GetResume(),
		Destroy: r.GetDestroy(), DestroyDisabled: r.GetDestroyDisabled(),
	}
}

func registerEphemeralVmChannels(r *Registry, gitGateway gitgatewayv1.GitGatewayServiceClient, project projectv1.ProjectServiceClient, infra infrafleetv1.InfraFleetServiceClient) {
	r.Register("ephemeralVm.listRecipes", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		in, err := decodeArg[struct {
			RepoID string `json:"repoId"`
		}](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		resp, err := gitGateway.ReadEphemeralVmRecipes(rpcCtx, &gitgatewayv1.ReadEphemeralVmRecipesRequest{RepoId: in.RepoID})
		if err != nil {
			return nil, err
		}
		recipes := make([]ephemeralVmRecipeView, 0, len(resp.GetRecipes()))
		for _, rec := range resp.GetRecipes() {
			recipes = append(recipes, toEphemeralVmRecipeView(rec))
		}
		return map[string]any{
			"repoPath": resp.GetRepoPath(), "recipes": recipes, "diagnostics": resp.GetDiagnostics(),
		}, nil
	})

	r.Register("ephemeralVm.doctor", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		in, err := decodeArg[struct {
			RepoID   string `json:"repoId"`
			RecipeID string `json:"recipeId"`
		}](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		resp, err := gitGateway.ReadEphemeralVmRecipes(rpcCtx, &gitgatewayv1.ReadEphemeralVmRecipesRequest{RepoId: in.RepoID})
		if err != nil {
			return nil, err
		}
		for _, rec := range resp.GetRecipes() {
			if rec.GetId() != in.RecipeID {
				continue
			}
			if rec.GetDestroyDisabled() || rec.GetDestroy() == "" {
				return map[string]any{"recipeId": in.RecipeID, "repoPath": resp.GetRepoPath(), "ok": true, "checks": []map[string]any{
					{"id": "create-command-present", "status": "pass", "message": "create command is configured"},
					{"id": "destroy-command-present", "status": "warn", "message": "no destroy command configured — cleanup will require manual teardown"},
				}}, nil
			}
			return map[string]any{"recipeId": in.RecipeID, "repoPath": resp.GetRepoPath(), "ok": true, "checks": []map[string]any{
				{"id": "create-command-present", "status": "pass", "message": "create command is configured"},
			}}, nil
		}
		return map[string]any{"recipeId": in.RecipeID, "repoPath": resp.GetRepoPath(), "ok": false, "checks": []map[string]any{
			{"id": "recipe-found", "status": "fail", "message": "recipe " + in.RecipeID + " not found in orca.yaml"},
		}}, nil
	})

	r.Register("ephemeralVm.getCleanupCommand", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		in, err := decodeArg[struct {
			RuntimeID string `json:"runtimeId"`
		}](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		// Resolve the runtime row first (need its repoId+recipeId to look up
		// the recipe's destroy command) — same infra client Step 4 below uses.
		listResp, err := infra.ListEphemeralVmRuntimes(rpcCtx, &infrafleetv1.ListEphemeralVmRuntimesRequest{})
		if err != nil {
			return nil, err
		}
		runtime := findEphemeralVmRuntimeByID(listResp.GetRuntimes(), in.RuntimeID)
		if runtime == nil {
			return map[string]any{"runtimeId": in.RuntimeID, "command": nil, "payloadJson": "", "cleanupDisabled": true, "message": "runtime not found"}, nil
		}
		recipesResp, err := gitGateway.ReadEphemeralVmRecipes(rpcCtx, &gitgatewayv1.ReadEphemeralVmRecipesRequest{RepoId: runtime.GetRepoId()})
		if err != nil {
			return nil, err
		}
		for _, rec := range recipesResp.GetRecipes() {
			if rec.GetId() != runtime.GetRecipeId() {
				continue
			}
			if rec.GetDestroyDisabled() || rec.GetDestroy() == "" {
				return map[string]any{"runtimeId": in.RuntimeID, "command": nil, "payloadJson": "", "cleanupDisabled": true}, nil
			}
			return map[string]any{"runtimeId": in.RuntimeID, "command": rec.GetDestroy(), "payloadJson": "", "cleanupDisabled": false}, nil
		}
		return map[string]any{"runtimeId": in.RuntimeID, "command": nil, "payloadJson": "", "cleanupDisabled": true, "message": "recipe not found"}, nil
	})

	r.Register("ephemeralVm.attachWorkspace", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		in, err := decodeArg[struct {
			RuntimeID   string `json:"runtimeId"`
			WorkspaceID string `json:"workspaceId"`
		}](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		// No connection resolution needed — AttachWorkspace is pure
		// bookkeeping (TASK-004's correction to SOL-004's original sketch).
		resp, err := infra.AttachEphemeralVmWorkspace(rpcCtx, &infrafleetv1.AttachEphemeralVmWorkspaceRequest{
			RuntimeId: in.RuntimeID, WorkspaceId: in.WorkspaceID,
		})
		if err != nil {
			return nil, err
		}
		return toEphemeralVmRuntimeView(resp), nil
	})

	r.Register("ephemeralVm.suspendWorkspace", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		in, err := decodeArg[struct {
			WorkspaceID string `json:"workspaceId"`
		}](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()

		listResp, err := infra.ListEphemeralVmRuntimes(rpcCtx, &infrafleetv1.ListEphemeralVmRuntimesRequest{})
		if err != nil {
			return nil, err
		}
		runtime := findEphemeralVmRuntimeByWorkspaceID(listResp.GetRuntimes(), in.WorkspaceID)
		if runtime == nil {
			return nil, fmt.Errorf("EPHEMERAL_VM_NOT_ATTACHED: no runtime is attached to workspace %s", in.WorkspaceID)
		}
		// TASK-006: an ssh-type recipe result requires the Dev Server Agent
		// to become an outbound SSH client to a third host — a capability
		// gap this bug set doesn't build. A distinct, permanent error code
		// (not INFRA_EPHEMERAL_VM_UNSUPPORTED, which self-heals once agent/
		// gains vm.exec) keeps that boundary visible instead of implying
		// this will start working once vm.exec ships.
		if runtime.GetConnectionType() == "ssh" {
			return nil, fmt.Errorf("INFRA_EPHEMERAL_VM_SSH_UNSUPPORTED: this recipe provisions a bare SSH host, which the Dev Server Agent cannot yet reach outbound — see specs/backend-go/bugs/missing-v3/tasks/TASK-006-ephemeral-vm-ssh-lifecycle-blocked-on-agent.md")
		}
		command, err := resolveEphemeralVmRecipeCommand(rpcCtx, gitGateway, runtime.GetRepoId(), runtime.GetRecipeId(), "suspend")
		if err != nil {
			return nil, err
		}
		connectionID, err := resolveConnectionIDForWorktree(rpcCtx, infra, in.WorkspaceID)
		if err != nil {
			return nil, err
		}
		resp, err := infra.SuspendEphemeralVmWorkspace(rpcCtx, &infrafleetv1.SuspendEphemeralVmWorkspaceRequest{
			ConnectionId: connectionID, WorkspaceId: in.WorkspaceID, Command: command,
		})
		if err != nil {
			return nil, err
		}
		return toEphemeralVmRuntimeView(resp), nil
	})

	r.Register("ephemeralVm.resumeWorkspace", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		in, err := decodeArg[struct {
			WorkspaceID string `json:"workspaceId"`
		}](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()

		listResp, err := infra.ListEphemeralVmRuntimes(rpcCtx, &infrafleetv1.ListEphemeralVmRuntimesRequest{})
		if err != nil {
			return nil, err
		}
		runtime := findEphemeralVmRuntimeByWorkspaceID(listResp.GetRuntimes(), in.WorkspaceID)
		if runtime == nil {
			return nil, fmt.Errorf("EPHEMERAL_VM_NOT_ATTACHED: no runtime is attached to workspace %s", in.WorkspaceID)
		}
		if runtime.GetConnectionType() == "ssh" {
			return nil, fmt.Errorf("INFRA_EPHEMERAL_VM_SSH_UNSUPPORTED: this recipe provisions a bare SSH host, which the Dev Server Agent cannot yet reach outbound — see specs/backend-go/bugs/missing-v3/tasks/TASK-006-ephemeral-vm-ssh-lifecycle-blocked-on-agent.md")
		}
		command, err := resolveEphemeralVmRecipeCommand(rpcCtx, gitGateway, runtime.GetRepoId(), runtime.GetRecipeId(), "resume")
		if err != nil {
			return nil, err
		}
		connectionID, err := resolveConnectionIDForWorktree(rpcCtx, infra, in.WorkspaceID)
		if err != nil {
			return nil, err
		}
		resp, err := infra.ResumeEphemeralVmWorkspace(rpcCtx, &infrafleetv1.ResumeEphemeralVmWorkspaceRequest{
			ConnectionId: connectionID, WorkspaceId: in.WorkspaceID, Command: command,
		})
		if err != nil {
			return nil, err
		}
		return toEphemeralVmRuntimeView(resp), nil
	})

	r.Register("ephemeralVm.cleanup", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		in, err := decodeArg[struct {
			RuntimeID string `json:"runtimeId"`
		}](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()

		listResp, err := infra.ListEphemeralVmRuntimes(rpcCtx, &infrafleetv1.ListEphemeralVmRuntimesRequest{})
		if err != nil {
			return nil, err
		}
		runtime := findEphemeralVmRuntimeByID(listResp.GetRuntimes(), in.RuntimeID)
		if runtime == nil {
			return nil, fmt.Errorf("EPHEMERAL_VM_RUNTIME_NOT_FOUND: %s", in.RuntimeID)
		}
		if runtime.GetConnectionType() == "ssh" {
			return nil, fmt.Errorf("INFRA_EPHEMERAL_VM_SSH_UNSUPPORTED: this recipe provisions a bare SSH host, which the Dev Server Agent cannot yet reach outbound — see specs/backend-go/bugs/missing-v3/tasks/TASK-006-ephemeral-vm-ssh-lifecycle-blocked-on-agent.md")
		}
		var command, connectionID string
		if runtime.GetWorkspaceId() != "" {
			// Only relay a destroy command if this runtime was ever attached
			// to a workspace — otherwise there is no worktree to resolve a
			// connection from (TASK-004's "open design note"); mark
			// destroyed locally with no agent call, matching desktop's own
			// always-progresses-to-a-terminal-state behavior.
			command, err = resolveEphemeralVmRecipeCommand(rpcCtx, gitGateway, runtime.GetRepoId(), runtime.GetRecipeId(), "destroy")
			if err != nil {
				return nil, err
			}
			connectionID, err = resolveConnectionIDForWorktree(rpcCtx, infra, runtime.GetWorkspaceId())
			if err != nil {
				return nil, err
			}
		}
		resp, err := infra.CleanupEphemeralVmWorkspace(rpcCtx, &infrafleetv1.CleanupEphemeralVmWorkspaceRequest{
			ConnectionId: connectionID, RuntimeId: in.RuntimeID, Command: command,
		})
		if err != nil {
			return nil, err
		}
		return toEphemeralVmRuntimeView(resp), nil
	})

	registerEphemeralVmListRecipeCatalog(r, gitGateway, project)
	registerEphemeralVmListRuntimes(r, infra)
	registerEphemeralVmProvisionChannel(r, gitGateway, infra)
	registerEphemeralVmCancelProvisionChannel(r)
}

// ephemeralVmProvisionArgs — see runtime-ephemeral-vm-client.ts:224-229's
// real environment/paired-branch request shape: connectionId/recipeId/
// runtimeId only, no command (this channel resolves it server-side, same as
// suspendWorkspace/resumeWorkspace/cleanup do for their own command field).
type ephemeralVmProvisionArgs struct {
	ConnectionID string `json:"connectionId"`
	RecipeID     string `json:"recipeId"`
	RuntimeID    string `json:"runtimeId"`
}

type ephemeralVmProvisionAckView struct {
	ProvisionID string `json:"provisionId"`
}

// registerEphemeralVmProvisionChannel wires ephemeralVm.provision — mirrors
// registerTerminalCreateChannel/registerOnboardingOpenGhAuthTerminalChannel's
// spawn-then-open-stream-then-register pattern, with 2 differences: (1) the
// "spawn" step here is resolving repoId+the recipe's `create` command
// (StreamVmProvisionRequest carries no command field of its own reason —
// infra-fleet-service must not depend on git-gateway-service, see
// EphemeralVmRelay's doc comment — so wscompat resolves it exactly like
// suspend/resume/cleanup already do); (2) the stream itself
// (StreamVmProvision) is server-streaming only, no client->server frames
// after the initial request, unlike AttachPty.
//
// Registered via RegisterStreamChannel: the invoke must both ack with
// {provisionId} (so the caller can later cancelProvision) AND open the live
// subscription that delivers ephemeralVm.onProvisionEvent push frames for
// the rest of the provision run.
func registerEphemeralVmProvisionChannel(r *Registry, gitGateway gitgatewayv1.GitGatewayServiceClient, infra infrafleetv1.InfraFleetServiceClient) {
	r.RegisterStreamChannel("ephemeralVm.provision", func(ctx context.Context, id Identity, args []json.RawMessage) (any, <-chan PushEvent, error) {
		in, err := decodeArg[ephemeralVmProvisionArgs](args, 0)
		if err != nil {
			return nil, nil, err
		}
		provisions := provisionStreamsFromContext(ctx)
		if provisions == nil {
			return nil, nil, errNoProvisionStreamRegistry
		}

		invokeCtx := gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID, Role: id.Role})
		rpcCtx, cancelRPC := context.WithTimeout(invokeCtx, rpcTimeout)
		defer cancelRPC()

		// Resolve repoId from the existing runtime row — ephemeralVm.provision's
		// real request args carry only recipeId/runtimeId (no repoId), same
		// client-side-filter lookup getCleanupCommand already uses.
		listResp, err := infra.ListEphemeralVmRuntimes(rpcCtx, &infrafleetv1.ListEphemeralVmRuntimesRequest{})
		if err != nil {
			return nil, nil, err
		}
		runtime := findEphemeralVmRuntimeByID(listResp.GetRuntimes(), in.RuntimeID)
		if runtime == nil {
			return nil, nil, fmt.Errorf("EPHEMERAL_VM_RUNTIME_NOT_FOUND: %s", in.RuntimeID)
		}
		command, err := resolveEphemeralVmRecipeCommand(rpcCtx, gitGateway, runtime.GetRepoId(), in.RecipeID, "create")
		if err != nil {
			return nil, nil, err
		}

		provisionID, err := newProvisionID()
		if err != nil {
			return nil, nil, err
		}

		// See attachContext's doc comment (channels_terminal.go): the stream
		// MUST outlive this invoke's own rpcTimeout deadline.
		streamCtx, cancel := attachContext(id)
		stream, err := infra.StreamVmProvision(streamCtx, &infrafleetv1.StreamVmProvisionRequest{
			ConnectionId: in.ConnectionID, RecipeId: in.RecipeID, RuntimeId: in.RuntimeID, Command: command,
		})
		if err != nil {
			cancel()
			return nil, nil, err
		}

		entry := &provisionStreamEntry{stream: stream, cancel: cancel}
		provisions.put(provisionID, entry)

		events := make(chan PushEvent)
		go drainVmProvisionOutput(streamCtx, provisionID, entry, provisions, events)

		return ephemeralVmProvisionAckView{ProvisionID: provisionID}, events, nil
	})
}

// drainVmProvisionOutput reads every VmProvisionEvent the server pushes for
// one provision run until the stream ends (cancelProvision's cancel(), the
// agent's recipe process exiting, or a transport error), forwarding each as
// a PushEvent on events — mirrors drainAttachPtyOutput exactly
// (channels_terminal.go), including removing provisionID from provisions and
// closing events when the stream ends for ANY reason, so a stream that ends
// on its own (never cancelled) still gets its registry entry cleaned up
// (BE-SOL-EVM-002 §Rủi ro's documented leak risk — this must NOT depend on
// cancelProvision ever being called).
func drainVmProvisionOutput(streamCtx context.Context, provisionID string, entry *provisionStreamEntry, provisions *provisionStreamRegistry, events chan<- PushEvent) {
	defer close(events)
	defer provisions.remove(provisionID)
	for {
		event, err := entry.stream.Recv()
		if err != nil {
			return // stream ended — io.EOF on a clean close, or a real transport error either way
		}
		ev := PushEvent{Channel: "ephemeralVm.onProvisionEvent", Args: []any{toEphemeralVmProvisionEventView(provisionID, event)}}
		select {
		case events <- ev:
		case <-streamCtx.Done():
			return
		}
	}
}

// toEphemeralVmProvisionEventView maps 1 VmProvisionEvent onto the wire
// shape frontend's EphemeralVmProvisionStreamEvent expects (type/chunk on
// stdout|stderr, type/result on result, type/error on error) — see
// runtime-ephemeral-vm-client.ts:203-206. provisionId is included so a
// caller subscribed to more than one concurrent provision (unlikely today,
// but not structurally prevented) can tell events apart.
func toEphemeralVmProvisionEventView(provisionID string, event *infrafleetv1.VmProvisionEvent) map[string]any {
	view := map[string]any{"provisionId": provisionID, "type": event.GetType()}
	switch event.GetType() {
	case "result":
		view["result"] = toEphemeralVmProvisionResultView(event.GetResult())
	case "error":
		// server_ephemeral_vm.go's toProtoVmProvisionEvent reuses `chunk` to
		// carry the error message for Type=="error" (VmProvisionEvent has no
		// dedicated error field) — re-surfaced under `error` here so the
		// frontend's EphemeralVmProvisionStreamEvent{type:'error';error:string}
		// shape gets the field name it actually expects.
		view["error"] = event.GetChunk()
	default: // "stdout" | "stderr"
		view["chunk"] = event.GetChunk()
	}
	return view
}

func toEphemeralVmProvisionResultView(r *infrafleetv1.VmProvisionResult) map[string]any {
	view := map[string]any{"type": r.GetType(), "projectRoot": r.GetProjectRoot()}
	if r.GetType() == "orca-server" {
		view["pairingCode"] = r.GetPairingCode()
	}
	if target := r.GetSshTarget(); target != nil {
		view["sshTarget"] = map[string]any{
			"label": target.GetLabel(), "host": target.GetHost(), "port": target.GetPort(), "username": target.GetUsername(),
			"identityFile": target.GetIdentityFile(), "identityAgent": target.GetIdentityAgent(),
			"identitiesOnly": target.GetIdentitiesOnly(), "proxyCommand": target.GetProxyCommand(),
			"jumpHost": target.GetJumpHost(), "relayGracePeriodSeconds": target.GetRelayGracePeriodSeconds(),
		}
	}
	return view
}

type ephemeralVmCancelProvisionArgs struct {
	ProvisionID string `json:"provisionId"`
}

type ephemeralVmCancelProvisionResultView struct {
	Cancelled bool `json:"cancelled"`
}

// registerEphemeralVmCancelProvisionChannel wires ephemeralVm.cancelProvision
// — cancels THIS connection's Go-side StreamVmProvision subscription
// (entry.cancel(), which unblocks entry.stream.Recv() in
// drainVmProvisionOutput and tears down the gRPC stream). This is distinct
// from EphemeralVmRelay.CancelProvision (TASK-BE-EVM-004, infra-fleet-service),
// which relays vm.cancelProvision to the AGENT to abort its in-flight
// recipe process — two different concerns, matching TASK-BE-EVM-004's own
// doc comment on that method. This channel does not call that RPC at all
// (out of scope for this pass — cancelling only stops the caller from
// hearing more about a provision it no longer cares about, it does not stop
// the agent's recipe from actually running to completion).
func registerEphemeralVmCancelProvisionChannel(r *Registry) {
	r.Register("ephemeralVm.cancelProvision", func(ctx context.Context, _ Identity, args []json.RawMessage) (any, error) {
		in, err := decodeArg[ephemeralVmCancelProvisionArgs](args, 0)
		if err != nil {
			return nil, err
		}
		provisions := provisionStreamsFromContext(ctx)
		if provisions == nil {
			return nil, errNoProvisionStreamRegistry
		}
		entry, ok := provisions.get(in.ProvisionID)
		if !ok {
			return ephemeralVmCancelProvisionResultView{Cancelled: false}, nil
		}
		entry.cancel() // drainVmProvisionOutput's own cleanup removes the registry entry once Recv observes the cancellation
		return ephemeralVmCancelProvisionResultView{Cancelled: true}, nil
	})
}

// findEphemeralVmRuntimeByWorkspaceID resolves a runtime by its attached
// workspace/worktree id — same client-side-filter reasoning as
// findEphemeralVmRuntimeByID.
func findEphemeralVmRuntimeByWorkspaceID(runtimes []*infrafleetv1.EphemeralVmRuntime, workspaceID string) *infrafleetv1.EphemeralVmRuntime {
	for _, rt := range runtimes {
		if rt.GetWorkspaceId() == workspaceID {
			return rt
		}
	}
	return nil
}

// resolveEphemeralVmRecipeCommand fetches repoId's recipes and returns the
// named field ("create" | "suspend" | "resume" | "destroy") for recipeId, ""
// if the recipe/field is absent — command="" is a real, valid case
// (SuspendWorkspace/ResumeWorkspace/CleanupWorkspace's usecase-level
// "nothing to relay" branch, TASK-004) for suspend/resume/destroy, not an
// error. "create" was added by TASK-BE-EVM-005 (ephemeralVm.provision) —
// unlike the other 3, a recipe's create command is never optional/disabled.
func resolveEphemeralVmRecipeCommand(ctx context.Context, gitGateway gitgatewayv1.GitGatewayServiceClient, repoID, recipeID, field string) (string, error) {
	resp, err := gitGateway.ReadEphemeralVmRecipes(ctx, &gitgatewayv1.ReadEphemeralVmRecipesRequest{RepoId: repoID})
	if err != nil {
		return "", err
	}
	for _, rec := range resp.GetRecipes() {
		if rec.GetId() != recipeID {
			continue
		}
		switch field {
		case "create":
			return rec.GetCreate(), nil
		case "suspend":
			return rec.GetSuspend(), nil
		case "resume":
			return rec.GetResume(), nil
		case "destroy":
			if rec.GetDestroyDisabled() {
				return "", nil
			}
			return rec.GetDestroy(), nil
		}
	}
	return "", nil
}

// resolveConnectionIDForWorktree mirrors registerBrowserRelay's worktree ->
// connectionId resolution (channels_browser.go).
func resolveConnectionIDForWorktree(ctx context.Context, infra infrafleetv1.InfraFleetServiceClient, worktreeID string) (string, error) {
	if worktreeID == "" {
		return "", nil
	}
	resolved, err := infra.ResolveConnection(ctx, &infrafleetv1.ResolveConnectionRequest{WorktreeId: worktreeID})
	if err != nil {
		return "", err
	}
	if !resolved.GetConnected() {
		return "", nil
	}
	return resolved.GetConnectionId(), nil
}

// ephemeralVmCatalogEntry is ephemeralVm.listRecipeCatalog's per-repo entry.
type ephemeralVmCatalogEntry struct {
	RepoID      string                  `json:"repoId"`
	RepoName    string                  `json:"repoName"`
	RepoPath    string                  `json:"repoPath"`
	Recipes     []ephemeralVmRecipeView `json:"recipes"`
	Diagnostics []string                `json:"diagnostics"`
}

// registerEphemeralVmListRecipeCatalog backs ephemeralVm.listRecipeCatalog,
// called with zero args (runtime-ephemeral-vm-client.ts's
// listRuntimeEphemeralVmRecipeCatalog) — unlike listRecipes/doctor, there is
// no repoId to scope by. Identity carries only TenantID/UserID/Role — no
// project scoping either — so the only faithful reading of "list the
// catalog across all repos" is every project the tenant/caller can see,
// reusing registerOrcaProjectSharingChannels's ListProjects -> per-project
// N+1 loop shape, extended one level further to ListRepos ->
// per-repo ReadEphemeralVmRecipes.
func registerEphemeralVmListRecipeCatalog(r *Registry, gitGateway gitgatewayv1.GitGatewayServiceClient, project projectv1.ProjectServiceClient) {
	r.Register("ephemeralVm.listRecipeCatalog", func(ctx context.Context, id Identity, _ []json.RawMessage) (any, error) {
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()

		projectsResp, err := project.ListProjects(rpcCtx, &projectv1.ListProjectsRequest{TenantId: id.TenantID})
		if err != nil {
			return nil, err
		}
		var entries []ephemeralVmCatalogEntry
		for _, p := range projectsResp.GetProjects() {
			reposResp, err := project.ListRepos(rpcCtx, &projectv1.ListReposRequest{ProjectId: p.GetId()})
			if err != nil {
				return nil, err
			}
			for _, repo := range reposResp.GetRepos() {
				recipesResp, err := gitGateway.ReadEphemeralVmRecipes(rpcCtx, &gitgatewayv1.ReadEphemeralVmRecipesRequest{RepoId: repo.GetId()})
				if err != nil {
					return nil, err
				}
				if len(recipesResp.GetRecipes()) == 0 && len(recipesResp.GetDiagnostics()) == 0 {
					continue // mirrors desktop's listRecipeCatalog filter — skip repos with nothing to show
				}
				recipes := make([]ephemeralVmRecipeView, 0, len(recipesResp.GetRecipes()))
				for _, rec := range recipesResp.GetRecipes() {
					recipes = append(recipes, toEphemeralVmRecipeView(rec))
				}
				entries = append(entries, ephemeralVmCatalogEntry{
					RepoID: repo.GetId(), RepoName: repo.GetDisplayName(), RepoPath: recipesResp.GetRepoPath(),
					Recipes: recipes, Diagnostics: recipesResp.GetDiagnostics(),
				})
			}
		}
		return entries, nil
	})
}

// registerEphemeralVmListRuntimes backs ephemeralVm.listRuntimes — a plain
// Postgres read, no relay.
func registerEphemeralVmListRuntimes(r *Registry, infra infrafleetv1.InfraFleetServiceClient) {
	r.Register("ephemeralVm.listRuntimes", func(ctx context.Context, id Identity, _ []json.RawMessage) (any, error) {
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		resp, err := infra.ListEphemeralVmRuntimes(rpcCtx, &infrafleetv1.ListEphemeralVmRuntimesRequest{})
		if err != nil {
			return nil, err
		}
		out := make([]map[string]any, 0, len(resp.GetRuntimes()))
		for _, rt := range resp.GetRuntimes() {
			out = append(out, toEphemeralVmRuntimeView(rt))
		}
		return out, nil
	})
}

// findEphemeralVmRuntimeByID and its recipe command are resolved by listing
// every runtime and filtering client-side — infra-fleet-service exposes no
// by-id/by-workspace RPC of its own beyond ListEphemeralVmRuntimes (see
// TASK-002/004's "plain Postgres read" scope).
func findEphemeralVmRuntimeByID(runtimes []*infrafleetv1.EphemeralVmRuntime, id string) *infrafleetv1.EphemeralVmRuntime {
	for _, rt := range runtimes {
		if rt.GetId() == id {
			return rt
		}
	}
	return nil
}

// toEphemeralVmRuntimeView is the shared wire shape for
// listRuntimes/attachWorkspace/suspendWorkspace/resumeWorkspace/cleanup
// (TASK-005 extends this file with the latter 4 channels, reusing this
// view helper).
//
// TASK-BE-EVM-010: field-by-field audit against frontend's
// EphemeralVmRuntimeRecord Zod schema (frontend/src/shared/
// ephemeral-vm-runtimes.ts) found connectionType/environmentId renamed here
// to connectionMode/runtimeEnvironmentId (same data, frontend's field
// names), createdAt/updatedAt added (domain.EphemeralVmRuntime already has
// both — proto EphemeralVmRuntime.created_at/updated_at, TASK-BE-EVM-002),
// and status remapped onto frontend's vocabulary (see
// ephemeralVmFrontendStatus). cleanupStatus/recipeResult are NOT
// synthesized beyond the one unambiguous case below: infra-fleet-service
// tracks no cleanup sub-state machine or per-runtime recipe/connection
// result distinct from Status, and inventing either risks reporting a
// cleanup attempt as "not started" when it actually failed, or fabricating
// a pairing code/project root that was never real. Full parity needs new
// backend persistence (recipe/connection result, distinct cleanup state) —
// left as a follow-up, not fabricated here.
func toEphemeralVmRuntimeView(rt *infrafleetv1.EphemeralVmRuntime) map[string]any {
	view := map[string]any{
		"id": rt.GetId(), "repoId": rt.GetRepoId(), "recipeId": rt.GetRecipeId(),
		"status":    ephemeralVmFrontendStatus(rt.GetStatus()),
		"lastError": rt.GetLastError(),
		"createdAt": ephemeralVmRuntimeTimestampMillis(rt.GetCreatedAt()),
		"updatedAt": ephemeralVmRuntimeTimestampMillis(rt.GetUpdatedAt()),
	}
	// workspaceId/connectionMode/runtimeEnvironmentId: BE leaves these unset
	// ("") until AttachWorkspace/create/resume's result is parsed — omit
	// rather than send an empty string, since the frontend schema requires
	// non-empty when present (TASK-BE-EVM-010's round-trip test caught this
	// for workspaceId specifically: EphemeralVmRuntimeRecordSchema's
	// workspaceId is `z.string().min(1).optional()`).
	if workspaceID := rt.GetWorkspaceId(); workspaceID != "" {
		view["workspaceId"] = workspaceID
	}
	if connectionType := rt.GetConnectionType(); connectionType != "" {
		view["connectionMode"] = connectionType
	}
	if environmentID := rt.GetEnvironmentId(); environmentID != "" {
		view["runtimeEnvironmentId"] = environmentID
	}
	if rt.GetStatus() == "destroyed" {
		view["cleanupStatus"] = "succeeded"
	}
	return view
}

// ephemeralVmFrontendStatus maps infra-fleet-service's Status vocabulary
// ("provisioning"|"active"|"suspended"|"error"|"destroyed",
// ephemeral_vm_runtime.go:19) onto frontend's EphemeralVmRuntimeStatusSchema.
// provisioning/suspended already match; active->running and
// destroyed->cleaned are the same concept under the frontend's name.
// "error" is reached by suspend, resume, AND cleanup failure alike
// (ephemeral_vm_relay.go, UpdateStatus(..., "error", ...)) with no way to
// tell which from Status alone — mapped to frontend's generic "failed"
// rather than guessing a specific suspend_failed/resume_failed/
// cleanup_failed (TASK-BE-EVM-010: no fabricated specificity).
func ephemeralVmFrontendStatus(status string) string {
	switch status {
	case "active":
		return "running"
	case "destroyed":
		return "cleaned"
	case "error":
		return "failed"
	default:
		return status // "provisioning" | "suspended" already match; "" passes through unmapped.
	}
}

// ephemeralVmRuntimeTimestampMillis converts a proto Timestamp to epoch
// milliseconds, matching frontend's EphemeralVmRuntimeRecordSchema
// (z.number().finite()). Production rows always set both timestamps
// (Postgres NOT NULL columns, see ephemeral_vm_runtime_repository.go); the
// nil guard only protects test fixtures that construct a bare
// *infrafleetv1.EphemeralVmRuntime{}.
func ephemeralVmRuntimeTimestampMillis(ts *timestamppb.Timestamp) int64 {
	if ts == nil {
		return 0
	}
	return ts.AsTime().UnixMilli()
}
