// channels_files.go — files.browseServerDir (TASK-BE-EVM-008,
// BE-SOL-EVM-003 §3): browse a directory on the dev server an ephemeral VM
// runtime's environmentId resolves to. Distinct from devServer.browseDir
// (channels.go) only in its caller-facing key — that channel takes a raw
// devServerId (the onboarding "Add a project" folder picker), this one
// takes an environmentId (the "5th machine" a repo's ephemeral VM recipe
// provisioned, TASK-BE-EVM-004..007). Mirrors devServer.browseDir's
// relay/response-mapping exactly, reusing its
// devServerBrowseDirEntryView/devServerBrowseDirResultView wire shape and
// its confirmed real agent RPC (fs.readDir via RelayByDevServer) — see that
// channel's doc comment (channels.go) for the fs.readDir shape/limitations
// audit this reuses verbatim.
package wscompat

import (
	"context"
	"encoding/json"
	"fmt"

	infrafleetv1 "github.com/stablyai/orca-go/proto/gen/go/orca/infrafleet/v1"

	gatewaygrpc "github.com/stablyai/orca-go/services/api-gateway/internal/adapter/grpc"
	"github.com/stablyai/orca-go/services/api-gateway/internal/usecase"
)

type filesBrowseServerDirArgs struct {
	EnvironmentID string `json:"environmentId"`
	Path          string `json:"path"`
}

// registerFilesBrowseServerDirChannel wires files.browseServerDir —
// environment_id IS the dev_server_id verbatim (BE-SOL-EVM-003 §1's
// design: "environment_id BẰNG LUÔN dev_server_id", no separate
// translation table/RPC), so this channel does NOT call
// FindDevServerByEnvironmentID (that method lives on
// infra-fleet-service's internal Go interface, unreachable from
// api-gateway across the process boundary — the task doc's own sketch
// assumed a same-process call, corrected here). Instead it resolves
// existence/connectivity the same way every other devServerId-keyed
// wscompat channel already does: ResolveConnection(dev_server_id=...)
// first (gives the same INFRA_TERMINAL_NO_COMPUTE_BOUND-style contract
// TASK-BE-EVM-007's SpawnTerminalSession fallback uses for an
// unresolvable environmentId), THEN relays via RelayByDevServer using
// the SAME id value as devServerId.
func registerFilesBrowseServerDirChannel(r *Registry, client infrafleetv1.InfraFleetServiceClient) {
	r.Register("files.browseServerDir", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		in, err := decodeArg[filesBrowseServerDirArgs](args, 0)
		if err != nil {
			return nil, err
		}
		if in.EnvironmentID == "" {
			return nil, fmt.Errorf("FILES_BROWSE_NO_ENVIRONMENT: environmentId is required")
		}
		path := in.Path
		if path == "" || path == "~" {
			path = "/"
		}

		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID, Role: id.Role})
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()

		resolved, err := client.ResolveConnection(rpcCtx, &infrafleetv1.ResolveConnectionRequest{DevServerId: in.EnvironmentID})
		if err != nil {
			return nil, err
		}
		if !resolved.GetConnected() {
			return nil, fmt.Errorf("INFRA_TERMINAL_NO_COMPUTE_BOUND: environment %q has no dev server or SSH connection bound", in.EnvironmentID)
		}

		paramsJSON, err := json.Marshal(map[string]any{"path": path, "depth": 1})
		if err != nil {
			return nil, err
		}
		resp, err := client.RelayByDevServer(rpcCtx, &infrafleetv1.RelayByDevServerRequest{
			DevServerId: in.EnvironmentID,
			Method:      "fs.readDir",
			ParamsJson:  string(paramsJSON),
		})
		if err != nil {
			return nil, err
		}

		var relayResult struct {
			Path    string `json:"path"`
			Entries []struct {
				Name string `json:"name"`
				Type string `json:"type"`
			} `json:"entries"`
		}
		if raw := resp.GetResultJson(); raw != "" {
			if err := json.Unmarshal([]byte(raw), &relayResult); err != nil {
				return nil, fmt.Errorf("files.browseServerDir: decoding relay result: %w", err)
			}
		}
		entries := make([]devServerBrowseDirEntryView, 0, len(relayResult.Entries))
		for _, e := range relayResult.Entries {
			entries = append(entries, devServerBrowseDirEntryView{
				Name:        e.Name,
				IsDirectory: e.Type == "directory",
				// fs.readDir does not report symlink-ness — see
				// devServer.browseDir's doc comment (channels.go).
				IsSymlink: false,
			})
		}
		resolvedPath := relayResult.Path
		if resolvedPath == "" {
			resolvedPath = path
		}
		return devServerBrowseDirResultView{ResolvedPath: resolvedPath, Entries: entries}, nil
	})
}
