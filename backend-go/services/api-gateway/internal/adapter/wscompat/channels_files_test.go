package wscompat

import (
	"context"
	"strings"
	"testing"

	infrafleetv1 "github.com/stablyai/orca-go/proto/gen/go/orca/infrafleet/v1"
)

// TestFilesBrowseServerDir_ResolvesEnvironmentIdToDevServer covers the
// happy path — environmentId is passed straight through as
// ResolveConnection's/RelayByDevServer's dev_server_id (BE-SOL-EVM-003
// §1's "environment_id BẰNG LUÔN dev_server_id" design), and the
// fs.readDir relay result maps onto {resolvedPath, entries}.
func TestFilesBrowseServerDir_ResolvesEnvironmentIdToDevServer(t *testing.T) {
	var gotResolveReq *infrafleetv1.ResolveConnectionRequest
	var gotRelayReq *infrafleetv1.RelayByDevServerRequest
	fake := &fakeInfraFleetClient{
		resolveConnectionFunc: func(_ context.Context, in *infrafleetv1.ResolveConnectionRequest) (*infrafleetv1.ResolveConnectionResponse, error) {
			gotResolveReq = in
			return &infrafleetv1.ResolveConnectionResponse{Connected: true}, nil
		},
		relayByDevServerFunc: func(_ context.Context, in *infrafleetv1.RelayByDevServerRequest) (*infrafleetv1.RelayResponse, error) {
			gotRelayReq = in
			return &infrafleetv1.RelayResponse{ResultJson: `{"path":"/repo","entries":[{"name":"src","type":"directory"},{"name":"README.md","type":"file"}]}`}, nil
		},
	}
	r := NewRegistry()
	registerFilesBrowseServerDirChannel(r, fake)

	got, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1", UserID: "user-1"}, "files.browseServerDir",
		argsJSON(t, filesBrowseServerDirArgs{EnvironmentID: "env-1", Path: "/repo"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if gotResolveReq == nil || gotResolveReq.GetDevServerId() != "env-1" {
		t.Fatalf("expected ResolveConnection to be called with dev_server_id=env-1, got %+v", gotResolveReq)
	}
	if gotRelayReq == nil || gotRelayReq.GetDevServerId() != "env-1" || gotRelayReq.GetMethod() != "fs.readDir" {
		t.Fatalf("expected RelayByDevServer(dev_server_id=env-1, method=fs.readDir), got %+v", gotRelayReq)
	}

	view, ok := got.(devServerBrowseDirResultView)
	if !ok {
		t.Fatalf("expected devServerBrowseDirResultView, got %T", got)
	}
	if view.ResolvedPath != "/repo" || len(view.Entries) != 2 {
		t.Fatalf("unexpected result: %+v", view)
	}
	if view.Entries[0].Name != "src" || !view.Entries[0].IsDirectory {
		t.Errorf("entry[0] = %+v, want src/directory", view.Entries[0])
	}
	if view.Entries[1].Name != "README.md" || view.Entries[1].IsDirectory {
		t.Errorf("entry[1] = %+v, want README.md/file", view.Entries[1])
	}
}

// TestFilesBrowseServerDir_UnresolvableEnvironmentIdReturnsError covers the
// not-connected branch — the same INFRA_TERMINAL_NO_COMPUTE_BOUND
// convention TASK-BE-EVM-007's SpawnTerminalSession fallback uses, and
// confirms RelayByDevServer is never called when resolution fails.
func TestFilesBrowseServerDir_UnresolvableEnvironmentIdReturnsError(t *testing.T) {
	relayCalled := false
	fake := &fakeInfraFleetClient{
		resolveConnectionFunc: func(context.Context, *infrafleetv1.ResolveConnectionRequest) (*infrafleetv1.ResolveConnectionResponse, error) {
			return &infrafleetv1.ResolveConnectionResponse{Connected: false}, nil
		},
		relayByDevServerFunc: func(context.Context, *infrafleetv1.RelayByDevServerRequest) (*infrafleetv1.RelayResponse, error) {
			relayCalled = true
			return &infrafleetv1.RelayResponse{}, nil
		},
	}
	r := NewRegistry()
	registerFilesBrowseServerDirChannel(r, fake)

	_, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1", UserID: "user-1"}, "files.browseServerDir",
		argsJSON(t, filesBrowseServerDirArgs{EnvironmentID: "env-never-provisioned", Path: "/"}))
	if err == nil {
		t.Fatal("expected an error when the environmentId doesn't resolve to a connected dev server")
	}
	if !strings.Contains(err.Error(), "INFRA_TERMINAL_NO_COMPUTE_BOUND") {
		t.Errorf("expected INFRA_TERMINAL_NO_COMPUTE_BOUND in error, got %v", err)
	}
	if relayCalled {
		t.Error("expected RelayByDevServer to never be called when the environmentId doesn't resolve")
	}
}

// TestFilesBrowseServerDir_RequiresEnvironmentId mirrors
// TestDevServerBrowseDirChannel_RequiresDevServerID's validation-error
// convention for the missing-required-field case.
func TestFilesBrowseServerDir_RequiresEnvironmentId(t *testing.T) {
	fake := &fakeInfraFleetClient{}
	r := NewRegistry()
	registerFilesBrowseServerDirChannel(r, fake)

	_, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1", UserID: "user-1"}, "files.browseServerDir",
		argsJSON(t, filesBrowseServerDirArgs{Path: "/"}))
	if err == nil {
		t.Fatal("expected an error when environmentId is empty")
	}
	if !strings.Contains(err.Error(), "FILES_BROWSE_NO_ENVIRONMENT") {
		t.Errorf("expected FILES_BROWSE_NO_ENVIRONMENT in error, got %v", err)
	}
}

// TestFilesBrowseServerDir_RelaysToAgentCorrectMethod is the direct
// regression test for TASK-BE-EVM-008's mandatory audit step: the agent
// method relayed to MUST be the real, confirmed "fs.readDir"
// (agent-rpc-dispatch-fs.ts), not a guessed/placeholder name like
// "devServer.browseDir" or "fs.listDirectory" (a real but DIFFERENT
// method, confirmed to exist but never called from backend-go today).
func TestFilesBrowseServerDir_RelaysToAgentCorrectMethod(t *testing.T) {
	var gotMethod string
	fake := &fakeInfraFleetClient{
		resolveConnectionFunc: func(context.Context, *infrafleetv1.ResolveConnectionRequest) (*infrafleetv1.ResolveConnectionResponse, error) {
			return &infrafleetv1.ResolveConnectionResponse{Connected: true}, nil
		},
		relayByDevServerFunc: func(_ context.Context, in *infrafleetv1.RelayByDevServerRequest) (*infrafleetv1.RelayResponse, error) {
			gotMethod = in.GetMethod()
			return &infrafleetv1.RelayResponse{ResultJson: `{"path":"/","entries":[]}`}, nil
		},
	}
	r := NewRegistry()
	registerFilesBrowseServerDirChannel(r, fake)

	if _, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1", UserID: "user-1"}, "files.browseServerDir",
		argsJSON(t, filesBrowseServerDirArgs{EnvironmentID: "env-1", Path: "/"})); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if gotMethod != "fs.readDir" {
		t.Errorf("expected relay method %q, got %q", "fs.readDir", gotMethod)
	}
}

// TestFilesBrowseServerDir_DefaultsTildeToRoot mirrors
// TestDevServerBrowseDirChannel_DefaultsTildeToRoot's honest-fallback
// contract (fs.readDir does no `~` expansion).
func TestFilesBrowseServerDir_DefaultsTildeToRoot(t *testing.T) {
	var gotParamsJSON string
	fake := &fakeInfraFleetClient{
		resolveConnectionFunc: func(context.Context, *infrafleetv1.ResolveConnectionRequest) (*infrafleetv1.ResolveConnectionResponse, error) {
			return &infrafleetv1.ResolveConnectionResponse{Connected: true}, nil
		},
		relayByDevServerFunc: func(_ context.Context, in *infrafleetv1.RelayByDevServerRequest) (*infrafleetv1.RelayResponse, error) {
			gotParamsJSON = in.GetParamsJson()
			return &infrafleetv1.RelayResponse{ResultJson: `{"path":"/","entries":[]}`}, nil
		},
	}
	r := NewRegistry()
	registerFilesBrowseServerDirChannel(r, fake)

	if _, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1", UserID: "user-1"}, "files.browseServerDir",
		argsJSON(t, filesBrowseServerDirArgs{EnvironmentID: "env-1", Path: "~"})); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(gotParamsJSON, `"path":"/"`) {
		t.Errorf("expected path to default to \"/\", got params %s", gotParamsJSON)
	}
}
