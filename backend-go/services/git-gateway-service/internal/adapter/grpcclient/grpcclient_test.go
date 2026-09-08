package grpcclient

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"google.golang.org/grpc"

	"github.com/stablyai/orca-go/common/tenant"
	infrafleetv1 "github.com/stablyai/orca-go/proto/gen/go/orca/infrafleet/v1"
	projectv1 "github.com/stablyai/orca-go/proto/gen/go/orca/project/v1"
	"github.com/stablyai/orca-go/services/git-gateway-service/internal/domain"
	"github.com/stablyai/orca-go/services/git-gateway-service/internal/usecase"
)

// fakeInfraFleetServiceClient implements infrafleetv1.InfraFleetServiceClient
// directly (no bufconn/wire-level gRPC) — this package's tests fake the
// port (the generated client interface), not the transport, matching this
// repo's usecase-test convention (e.g. internal/usecase/dispatch_test.go's
// fakeConnectionResolver/fakeGitExecutor).
type fakeInfraFleetServiceClient struct {
	infrafleetv1.InfraFleetServiceClient // embed: panics on any unimplemented method, which is intentional for these tests

	resolveConnectionResp *infrafleetv1.ResolveConnectionResponse
	resolveConnectionErr  error
	gotResolveConnection  *infrafleetv1.ResolveConnectionRequest

	relayResp *infrafleetv1.RelayResponse
	relayErr  error
	gotRelay  *infrafleetv1.RelayRequest

	// relayRespByMethod/gotRelayRequests support multi-call sequences (e.g.
	// CreateWorktree's git.worktree.add then git.exec follow-up) where a
	// single fixed relayResp/gotRelay pair can't distinguish which call is
	// which. When relayRespByMethod is non-nil, Relay looks up by
	// in.Method instead of returning relayResp.
	relayRespByMethod map[string]*infrafleetv1.RelayResponse
	gotRelayRequests  []*infrafleetv1.RelayRequest

	relayByDevServerResp *infrafleetv1.RelayResponse
	relayByDevServerErr  error
	gotRelayByDevServer  *infrafleetv1.RelayByDevServerRequest
}

func (f *fakeInfraFleetServiceClient) ResolveConnection(ctx context.Context, in *infrafleetv1.ResolveConnectionRequest, _ ...grpc.CallOption) (*infrafleetv1.ResolveConnectionResponse, error) {
	f.gotResolveConnection = in
	if f.resolveConnectionErr != nil {
		return nil, f.resolveConnectionErr
	}
	return f.resolveConnectionResp, nil
}

func (f *fakeInfraFleetServiceClient) Relay(ctx context.Context, in *infrafleetv1.RelayRequest, _ ...grpc.CallOption) (*infrafleetv1.RelayResponse, error) {
	f.gotRelay = in
	f.gotRelayRequests = append(f.gotRelayRequests, in)
	if f.relayErr != nil {
		return nil, f.relayErr
	}
	if f.relayRespByMethod != nil {
		return f.relayRespByMethod[in.GetMethod()], nil
	}
	return f.relayResp, nil
}

func (f *fakeInfraFleetServiceClient) RelayByDevServer(ctx context.Context, in *infrafleetv1.RelayByDevServerRequest, _ ...grpc.CallOption) (*infrafleetv1.RelayResponse, error) {
	f.gotRelayByDevServer = in
	if f.relayByDevServerErr != nil {
		return nil, f.relayByDevServerErr
	}
	return f.relayByDevServerResp, nil
}

func ctxWithTenant(t *testing.T) context.Context {
	t.Helper()
	return tenant.WithTenantID(context.Background(), "tenant-1")
}

func TestConnectionResolver_ResolveConnection_NotConnected(t *testing.T) {
	fake := &fakeInfraFleetServiceClient{
		resolveConnectionResp: &infrafleetv1.ResolveConnectionResponse{Connected: false},
	}
	r := NewConnectionResolver(fake)

	conn, err := r.ResolveConnection(ctxWithTenant(t), "wt-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if conn.Connected {
		t.Error("expected Connected=false")
	}
	if conn.RepoPath != "wt-1" {
		t.Errorf("expected RepoPath to fall back to worktreeID %q, got %q", "wt-1", conn.RepoPath)
	}
	if fake.gotResolveConnection.GetWorktreeId() != "wt-1" {
		t.Errorf("expected WorktreeId=wt-1 on the request, got %q", fake.gotResolveConnection.GetWorktreeId())
	}
	if fake.gotResolveConnection.GetConnectionId() != "" {
		t.Errorf("expected ConnectionId to stay unset (worktreeID is not a connections.id uuid), got %q", fake.gotResolveConnection.GetConnectionId())
	}
}

// TestConnectionResolver_ResolveConnection_MapsHiddenTargetID is
// TASK-BE-EVM-018's regression guard for the OTHER of the "2 proto" this
// task's gap closed (TASK-BE-EVM-015's gap #1): infrafleetv1.ResolveConnectionResponse.hidden_target_id
// is no longer silently dropped.
func TestConnectionResolver_ResolveConnection_MapsHiddenTargetID(t *testing.T) {
	fake := &fakeInfraFleetServiceClient{
		resolveConnectionResp: &infrafleetv1.ResolveConnectionResponse{
			Connected: true, RepoPath: "/remote/repo", ConnectionId: "conn-uuid-1", HiddenTargetId: "rt-1",
		},
	}
	r := NewConnectionResolver(fake)

	conn, err := r.ResolveConnection(ctxWithTenant(t), "wt-2")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if conn.HiddenTargetID != "rt-1" {
		t.Errorf("expected HiddenTargetID=rt-1 from the response, got %q", conn.HiddenTargetID)
	}
}

func TestConnectionResolver_ResolveConnection_Connected(t *testing.T) {
	fake := &fakeInfraFleetServiceClient{
		resolveConnectionResp: &infrafleetv1.ResolveConnectionResponse{
			Connected:    true,
			RepoPath:     "/remote/repo",
			ConnectionId: "conn-uuid-1",
		},
	}
	r := NewConnectionResolver(fake)

	conn, err := r.ResolveConnection(ctxWithTenant(t), "wt-2")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !conn.Connected {
		t.Error("expected Connected=true")
	}
	// ConnectionID must come from the response's real infra.connections.id,
	// not be echoed back as worktreeID — RelayExecutor's Relay RPC requires
	// that actual uuid (see relay_executor.go's Complete doc comment).
	if conn.ConnectionID != "conn-uuid-1" {
		t.Errorf("expected ConnectionID=conn-uuid-1 from the response, got %q", conn.ConnectionID)
	}
	if conn.RepoPath != "/remote/repo" {
		t.Errorf("expected RepoPath from response, got %q", conn.RepoPath)
	}
}

func TestConnectionResolver_ResolveConnection_NoTenantInContext(t *testing.T) {
	fake := &fakeInfraFleetServiceClient{}
	r := NewConnectionResolver(fake)

	if _, err := r.ResolveConnection(context.Background(), "wt-1"); !errors.Is(err, tenant.ErrNoTenant) {
		t.Errorf("expected tenant.ErrNoTenant, got %v", err)
	}
	if fake.gotResolveConnection != nil {
		t.Error("expected ResolveConnection not to be called without a tenant in context")
	}
}

func TestRelayExecutor_GetStatus_Success(t *testing.T) {
	resultJSON, err := json.Marshal(map[string]any{
		"branch": "main",
		"files": []map[string]any{
			{"path": "a.txt", "state": "modified"},
		},
	})
	if err != nil {
		t.Fatalf("marshal fixture: %v", err)
	}
	fake := &fakeInfraFleetServiceClient{
		relayResp: &infrafleetv1.RelayResponse{ResultJson: string(resultJSON)},
	}
	r := NewRelayExecutor(fake)

	status, err := r.GetStatus(ctxWithTenant(t), "/repo")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if status.Branch != "main" {
		t.Errorf("expected branch=main, got %q", status.Branch)
	}
	if len(status.Files) != 1 || status.Files[0].Path != "a.txt" {
		t.Errorf("unexpected files: %+v", status.Files)
	}
	if fake.gotRelay.GetMethod() != "git.status" {
		t.Errorf("expected method=git.status, got %q", fake.gotRelay.GetMethod())
	}
	if fake.gotRelay.GetConnectionId() != "/repo" {
		t.Errorf("expected connectionId=/repo, got %q", fake.gotRelay.GetConnectionId())
	}

	var params map[string]any
	if err := json.Unmarshal([]byte(fake.gotRelay.GetParamsJson()), &params); err != nil {
		t.Fatalf("unmarshal params: %v", err)
	}
	if params["worktreePath"] != "/repo" {
		t.Errorf("expected worktreePath param (real agent contract, see BUG-036/TASK-228), got %+v", params)
	}
}

// TestRelayExecutor_Stat_AgentErrorEnvelope_NumericCode guards against a bug
// found live in the fix this test was added for: the agent's JSON-RPC error
// code (AgentErrorCode, agent/src/shared/agent-wire-protocol.ts) is a JSON
// number (e.g. -33003), not a string. relay()'s envelope-detection struct
// originally typed Code as `string`, which made json.Unmarshal fail on any
// real error response (number into a string field) — silently falling
// through to "no error found" and treating the agent's rejection as success,
// the exact bug this envelope check exists to close. Must use json.Number.
func TestRelayExecutor_Stat_AgentErrorEnvelope_NumericCode(t *testing.T) {
	resultJSON, err := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"id":      1,
		"error":   map[string]any{"code": -33003, "message": "Not found: /repo/missing.md"},
	})
	if err != nil {
		t.Fatalf("marshal fixture: %v", err)
	}
	fake := &fakeInfraFleetServiceClient{
		relayResp: &infrafleetv1.RelayResponse{ResultJson: string(resultJSON)},
	}
	r := NewRelayExecutor(fake)

	_, err = r.Stat(ctxWithTenant(t), "/repo", "missing.md")
	if err == nil {
		t.Fatal("expected an error for a JSON-RPC error envelope, got nil (agent rejection was silently swallowed as success)")
	}
	if !strings.Contains(err.Error(), "Not found: /repo/missing.md") {
		t.Errorf("expected error to surface the agent's message, got: %v", err)
	}
}

func TestRelayExecutor_Commit_Success(t *testing.T) {
	resultJSON, err := json.Marshal(map[string]any{"commitSha": "abc123"})
	if err != nil {
		t.Fatalf("marshal fixture: %v", err)
	}
	fake := &fakeInfraFleetServiceClient{
		relayResp: &infrafleetv1.RelayResponse{ResultJson: string(resultJSON)},
	}
	r := NewRelayExecutor(fake)

	result, err := r.Commit(ctxWithTenant(t), "/repo", "my message", []string{"a.txt"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.CommitSHA != "abc123" {
		t.Errorf("expected commitSha=abc123, got %q", result.CommitSHA)
	}
	if fake.gotRelay.GetMethod() != "git.commit" {
		t.Errorf("expected method=git.commit, got %q", fake.gotRelay.GetMethod())
	}

	var params map[string]any
	if err := json.Unmarshal([]byte(fake.gotRelay.GetParamsJson()), &params); err != nil {
		t.Fatalf("unmarshal params: %v", err)
	}
	if params["message"] != "my message" {
		t.Errorf("expected message param, got %+v", params)
	}
}

func TestRelayExecutor_Push_RelayErrorPropagates(t *testing.T) {
	wantErr := errors.New("boom")
	fake := &fakeInfraFleetServiceClient{relayErr: wantErr}
	r := NewRelayExecutor(fake)

	_, err := r.Push(ctxWithTenant(t), "/repo", "origin", "main")
	if err == nil || !errors.Is(err, wantErr) {
		t.Fatalf("expected wrapped %v, got %v", wantErr, err)
	}
}

func TestRelayExecutor_NoTenantInContext(t *testing.T) {
	fake := &fakeInfraFleetServiceClient{}
	r := NewRelayExecutor(fake)

	if _, err := r.GetStatus(context.Background(), "/repo"); !errors.Is(err, tenant.ErrNoTenant) {
		t.Errorf("expected tenant.ErrNoTenant, got %v", err)
	}
	if fake.gotRelay != nil {
		t.Error("expected Relay not to be called without a tenant in context")
	}
}

// ── TASK-228: GetDiff now sends worktreePath+filePath ────────────────────

func TestRelayExecutor_GetDiff_SendsWorktreePathAndFilePath(t *testing.T) {
	fake := &fakeInfraFleetServiceClient{relayResp: &infrafleetv1.RelayResponse{}}
	r := NewRelayExecutor(fake)

	if _, err := r.GetDiff(ctxWithTenant(t), "/repo", "a.txt", true); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if fake.gotRelay.GetMethod() != "git.diff" {
		t.Errorf("expected method=git.diff, got %q", fake.gotRelay.GetMethod())
	}
	var params map[string]any
	if err := json.Unmarshal([]byte(fake.gotRelay.GetParamsJson()), &params); err != nil {
		t.Fatalf("unmarshal params: %v", err)
	}
	if params["worktreePath"] != "/repo" || params["filePath"] != "a.txt" || params["staged"] != true {
		t.Errorf("unexpected params: %+v", params)
	}
}

// ── TASK-208: Stage/Unstage always target the bulk relay method ──────────

func TestRelayExecutor_Stage_TargetsBulkMethod(t *testing.T) {
	fake := &fakeInfraFleetServiceClient{relayResp: &infrafleetv1.RelayResponse{}}
	r := NewRelayExecutor(fake)

	if _, err := r.Stage(ctxWithTenant(t), "/repo", []string{"a.txt"}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if fake.gotRelay.GetMethod() != "git.bulkStage" {
		t.Errorf("expected method=git.bulkStage even for a single path, got %q", fake.gotRelay.GetMethod())
	}
	var params map[string]any
	if err := json.Unmarshal([]byte(fake.gotRelay.GetParamsJson()), &params); err != nil {
		t.Fatalf("unmarshal params: %v", err)
	}
	if _, ok := params["filePaths"]; !ok {
		t.Errorf("expected filePaths param key, got %+v", params)
	}
}

func TestRelayExecutor_Unstage_TargetsBulkMethod(t *testing.T) {
	fake := &fakeInfraFleetServiceClient{relayResp: &infrafleetv1.RelayResponse{}}
	r := NewRelayExecutor(fake)

	if _, err := r.Unstage(ctxWithTenant(t), "/repo", []string{"a.txt", "b.txt"}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if fake.gotRelay.GetMethod() != "git.bulkUnstage" {
		t.Errorf("expected method=git.bulkUnstage, got %q", fake.gotRelay.GetMethod())
	}
}

// ── TASK-209: History/CheckIgnored/ForkSync param shapes ─────────────────

func TestRelayExecutor_History_DropsCursorRenamesBaseRef(t *testing.T) {
	fake := &fakeInfraFleetServiceClient{relayResp: &infrafleetv1.RelayResponse{}}
	r := NewRelayExecutor(fake)

	if _, err := r.History(ctxWithTenant(t), "/repo", "main", 10); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	var params map[string]any
	if err := json.Unmarshal([]byte(fake.gotRelay.GetParamsJson()), &params); err != nil {
		t.Fatalf("unmarshal params: %v", err)
	}
	if _, hasCursor := params["cursor"]; hasCursor {
		t.Errorf("expected no cursor param (real agent has no pagination), got %+v", params)
	}
	if params["baseRef"] != "main" {
		t.Errorf("expected baseRef param, got %+v", params)
	}
}

func TestRelayExecutor_CheckIgnored_ReturnsIgnoredSubset(t *testing.T) {
	resultJSON, err := json.Marshal(map[string]any{"ignoredPaths": []string{"node_modules"}})
	if err != nil {
		t.Fatalf("marshal fixture: %v", err)
	}
	fake := &fakeInfraFleetServiceClient{relayResp: &infrafleetv1.RelayResponse{ResultJson: string(resultJSON)}}
	r := NewRelayExecutor(fake)

	got, err := r.CheckIgnored(ctxWithTenant(t), "/repo", []string{"node_modules", "README.md"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 1 || got[0] != "node_modules" {
		t.Errorf("expected only the ignored subset, got %+v", got)
	}
}

func TestRelayExecutor_ForkSync_SendsExpectedUpstream(t *testing.T) {
	fake := &fakeInfraFleetServiceClient{relayResp: &infrafleetv1.RelayResponse{}}
	r := NewRelayExecutor(fake)

	if _, err := r.ForkSync(ctxWithTenant(t), "/repo", "origin/main"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	var params map[string]any
	if err := json.Unmarshal([]byte(fake.gotRelay.GetParamsJson()), &params); err != nil {
		t.Fatalf("unmarshal params: %v", err)
	}
	if params["expectedUpstream"] != "origin/main" {
		t.Errorf("expected expectedUpstream param, got %+v", params)
	}
}

func TestRelayExecutor_UpstreamStatus_SendsWorktreePathAndPushTarget(t *testing.T) {
	resultJSON, err := json.Marshal(map[string]any{"hasUpstream": true, "ahead": 2, "behind": 1})
	if err != nil {
		t.Fatalf("marshal fixture: %v", err)
	}
	fake := &fakeInfraFleetServiceClient{relayResp: &infrafleetv1.RelayResponse{ResultJson: string(resultJSON)}}
	r := NewRelayExecutor(fake)

	got, err := r.UpstreamStatus(ctxWithTenant(t), "/repo", &domain.PushTargetInput{RemoteName: "origin", BranchName: "main"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if fake.gotRelay.GetMethod() != "git.upstreamStatus" {
		t.Errorf("expected method=git.upstreamStatus, got %q", fake.gotRelay.GetMethod())
	}
	var params map[string]any
	if err := json.Unmarshal([]byte(fake.gotRelay.GetParamsJson()), &params); err != nil {
		t.Fatalf("unmarshal params: %v", err)
	}
	pushTarget, ok := params["pushTarget"].(map[string]any)
	if !ok {
		t.Fatalf("expected pushTarget param to be an object, got %+v", params)
	}
	if params["worktreePath"] != "/repo" || pushTarget["remoteName"] != "origin" || pushTarget["branchName"] != "main" {
		t.Errorf("unexpected params: %+v", params)
	}
	if !got.HasUpstream || got.Ahead != 2 || got.Behind != 1 {
		t.Errorf("unexpected result: %+v", got)
	}
}

func TestRelayExecutor_UpstreamStatus_NilPushTargetOmitsField(t *testing.T) {
	fake := &fakeInfraFleetServiceClient{relayResp: &infrafleetv1.RelayResponse{ResultJson: `{}`}}
	r := NewRelayExecutor(fake)

	if _, err := r.UpstreamStatus(ctxWithTenant(t), "/repo", nil); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	var params map[string]any
	if err := json.Unmarshal([]byte(fake.gotRelay.GetParamsJson()), &params); err != nil {
		t.Fatalf("unmarshal params: %v", err)
	}
	if _, ok := params["pushTarget"]; ok {
		t.Errorf("expected no pushTarget field when nil, got %+v", params)
	}
}

func TestRelayExecutor_RemoteCommitURL_SendsWorktreePathAndSha(t *testing.T) {
	resultJSON, err := json.Marshal(map[string]any{"url": "https://github.com/org/repo/commit/abc123"})
	if err != nil {
		t.Fatalf("marshal fixture: %v", err)
	}
	fake := &fakeInfraFleetServiceClient{relayResp: &infrafleetv1.RelayResponse{ResultJson: string(resultJSON)}}
	r := NewRelayExecutor(fake)

	got, err := r.RemoteCommitURL(ctxWithTenant(t), "/repo", "abc123")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if fake.gotRelay.GetMethod() != "git.remoteCommitUrl" {
		t.Errorf("expected method=git.remoteCommitUrl, got %q", fake.gotRelay.GetMethod())
	}
	var params map[string]any
	if err := json.Unmarshal([]byte(fake.gotRelay.GetParamsJson()), &params); err != nil {
		t.Fatalf("unmarshal params: %v", err)
	}
	if params["worktreePath"] != "/repo" || params["sha"] != "abc123" {
		t.Errorf("unexpected params: %+v", params)
	}
	if got != "https://github.com/org/repo/commit/abc123" {
		t.Errorf("unexpected url: %q", got)
	}
}

func TestRelayExecutor_RemoteFileURL_SendsWorktreePathPathAndRef(t *testing.T) {
	resultJSON, err := json.Marshal(map[string]any{"url": "https://github.com/org/repo/blob/main/a.txt"})
	if err != nil {
		t.Fatalf("marshal fixture: %v", err)
	}
	fake := &fakeInfraFleetServiceClient{relayResp: &infrafleetv1.RelayResponse{ResultJson: string(resultJSON)}}
	r := NewRelayExecutor(fake)

	got, err := r.RemoteFileURL(ctxWithTenant(t), "/repo", "a.txt", "main")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if fake.gotRelay.GetMethod() != "git.remoteFileUrl" {
		t.Errorf("expected method=git.remoteFileUrl, got %q", fake.gotRelay.GetMethod())
	}
	var params map[string]any
	if err := json.Unmarshal([]byte(fake.gotRelay.GetParamsJson()), &params); err != nil {
		t.Fatalf("unmarshal params: %v", err)
	}
	if params["worktreePath"] != "/repo" || params["path"] != "a.txt" || params["ref"] != "main" {
		t.Errorf("unexpected params: %+v", params)
	}
	if got != "https://github.com/org/repo/blob/main/a.txt" {
		t.Errorf("unexpected url: %q", got)
	}
}

// ── Group A — branch/ref operations (TASK-207) ───────────────────────────

func TestRelayExecutor_Checkout_SendsWorktreePathAndBranch(t *testing.T) {
	resultJSON, err := json.Marshal(map[string]any{"success": true, "branch": "feature"})
	if err != nil {
		t.Fatalf("marshal fixture: %v", err)
	}
	fake := &fakeInfraFleetServiceClient{relayResp: &infrafleetv1.RelayResponse{ResultJson: string(resultJSON)}}
	r := NewRelayExecutor(fake)

	result, err := r.Checkout(ctxWithTenant(t), "/repo", "feature")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if fake.gotRelay.GetMethod() != "git.checkout" {
		t.Errorf("expected method=git.checkout, got %q", fake.gotRelay.GetMethod())
	}
	var params map[string]any
	if err := json.Unmarshal([]byte(fake.gotRelay.GetParamsJson()), &params); err != nil {
		t.Fatalf("unmarshal params: %v", err)
	}
	if params["worktreePath"] != "/repo" || params["branch"] != "feature" {
		t.Errorf("unexpected params: %+v", params)
	}
	if _, hasCreate := params["create"]; hasCreate {
		t.Error("expected no create param — the real agent's git.checkout has no create-branch semantics")
	}
	if !result.Success || result.Branch != "feature" {
		t.Errorf("unexpected checkout result: %+v", result)
	}
}

func TestRelayExecutor_ListLocalBranches_ComposesViaGitExecForEachRef(t *testing.T) {
	resultJSON, err := json.Marshal(map[string]any{
		"stdout": "main\t\t\t*\nfeature\torigin/feature\t[ahead 1, behind 2]\t\n",
	})
	if err != nil {
		t.Fatalf("marshal fixture: %v", err)
	}
	fake := &fakeInfraFleetServiceClient{relayResp: &infrafleetv1.RelayResponse{ResultJson: string(resultJSON)}}
	r := NewRelayExecutor(fake)

	branches, err := r.ListLocalBranches(ctxWithTenant(t), "/repo")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if fake.gotRelay.GetMethod() != "git.exec" {
		t.Errorf("expected method=git.exec (composing via for-each-ref, not the narrower git.localBranches), got %q", fake.gotRelay.GetMethod())
	}
	var params map[string]any
	if err := json.Unmarshal([]byte(fake.gotRelay.GetParamsJson()), &params); err != nil {
		t.Fatalf("unmarshal params: %v", err)
	}
	args, ok := params["args"].([]any)
	if !ok || len(args) == 0 || args[0] != "for-each-ref" {
		t.Errorf("expected args[0]=for-each-ref, got %+v", params["args"])
	}
	if len(branches) != 2 {
		t.Fatalf("expected 2 branches, got %+v", branches)
	}
	if !branches[0].IsCurrent || branches[0].Name != "main" {
		t.Errorf("expected main to be current, got %+v", branches[0])
	}
	if branches[1].Name != "feature" || branches[1].Upstream != "origin/feature" || branches[1].Ahead != 1 || branches[1].Behind != 2 {
		t.Errorf("unexpected second branch: %+v", branches[1])
	}
}

func TestRelayExecutor_FastForward_NilPushTarget_OmitsField(t *testing.T) {
	fake := &fakeInfraFleetServiceClient{relayResp: &infrafleetv1.RelayResponse{}}
	r := NewRelayExecutor(fake)

	if _, err := r.FastForward(ctxWithTenant(t), "/repo", nil); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if fake.gotRelay.GetMethod() != "git.fastForward" {
		t.Errorf("expected method=git.fastForward, got %q", fake.gotRelay.GetMethod())
	}
	var params map[string]any
	if err := json.Unmarshal([]byte(fake.gotRelay.GetParamsJson()), &params); err != nil {
		t.Fatalf("unmarshal params: %v", err)
	}
	if _, hasPushTarget := params["pushTarget"]; hasPushTarget {
		t.Error("expected pushTarget to be omitted when nil, matching the real agent's undefined-pushTarget fallback")
	}
}

func TestRelayExecutor_FastForward_WithPushTarget_SendsStructuredShape(t *testing.T) {
	fake := &fakeInfraFleetServiceClient{relayResp: &infrafleetv1.RelayResponse{}}
	r := NewRelayExecutor(fake)

	pushTarget := &domain.PushTargetInput{RemoteName: "origin", BranchName: "main"}
	if _, err := r.FastForward(ctxWithTenant(t), "/repo", pushTarget); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	var params map[string]any
	if err := json.Unmarshal([]byte(fake.gotRelay.GetParamsJson()), &params); err != nil {
		t.Fatalf("unmarshal params: %v", err)
	}
	pt, ok := params["pushTarget"].(map[string]any)
	if !ok {
		t.Fatalf("expected pushTarget object, got %+v", params["pushTarget"])
	}
	if pt["remoteName"] != "origin" || pt["branchName"] != "main" {
		t.Errorf("unexpected pushTarget: %+v", pt)
	}
}

func TestRelayExecutor_RebaseFromBase_SendsWorktreePathAndBaseRef(t *testing.T) {
	fake := &fakeInfraFleetServiceClient{relayResp: &infrafleetv1.RelayResponse{}}
	r := NewRelayExecutor(fake)

	if _, err := r.RebaseFromBase(ctxWithTenant(t), "/repo", "main"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if fake.gotRelay.GetMethod() != "git.rebaseFromBase" {
		t.Errorf("expected method=git.rebaseFromBase, got %q", fake.gotRelay.GetMethod())
	}
	var params map[string]any
	if err := json.Unmarshal([]byte(fake.gotRelay.GetParamsJson()), &params); err != nil {
		t.Fatalf("unmarshal params: %v", err)
	}
	if params["worktreePath"] != "/repo" || params["baseRef"] != "main" {
		t.Errorf("unexpected params: %+v", params)
	}
}

func TestRelayExecutor_AbortRebase_SendsWorktreePath(t *testing.T) {
	fake := &fakeInfraFleetServiceClient{relayResp: &infrafleetv1.RelayResponse{}}
	r := NewRelayExecutor(fake)

	if _, err := r.AbortRebase(ctxWithTenant(t), "/repo"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if fake.gotRelay.GetMethod() != "git.abortRebase" {
		t.Errorf("expected method=git.abortRebase, got %q", fake.gotRelay.GetMethod())
	}
}

func TestRelayExecutor_AbortMerge_SendsWorktreePath(t *testing.T) {
	fake := &fakeInfraFleetServiceClient{relayResp: &infrafleetv1.RelayResponse{}}
	r := NewRelayExecutor(fake)

	if _, err := r.AbortMerge(ctxWithTenant(t), "/repo"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if fake.gotRelay.GetMethod() != "git.abortMerge" {
		t.Errorf("expected method=git.abortMerge, got %q", fake.gotRelay.GetMethod())
	}
}

func TestRelayExecutor_ConflictOperation_ReturnsBareDetectorString(t *testing.T) {
	resultJSON, err := json.Marshal("rebase")
	if err != nil {
		t.Fatalf("marshal fixture: %v", err)
	}
	fake := &fakeInfraFleetServiceClient{relayResp: &infrafleetv1.RelayResponse{ResultJson: string(resultJSON)}}
	r := NewRelayExecutor(fake)

	op, err := r.ConflictOperation(ctxWithTenant(t), "/repo")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if fake.gotRelay.GetMethod() != "git.conflictOperation" {
		t.Errorf("expected method=git.conflictOperation, got %q", fake.gotRelay.GetMethod())
	}
	var params map[string]any
	if err := json.Unmarshal([]byte(fake.gotRelay.GetParamsJson()), &params); err != nil {
		t.Fatalf("unmarshal params: %v", err)
	}
	if _, hasPath := params["path"]; hasPath {
		t.Error("expected no path param — the real git.conflictOperation is a detector only")
	}
	if op != "rebase" {
		t.Errorf("expected op=rebase, got %q", op)
	}
}

func TestRelayExecutor_ResolveConflict_UnsupportedOverRelay_NoRPCAttempted(t *testing.T) {
	fake := &fakeInfraFleetServiceClient{relayResp: &infrafleetv1.RelayResponse{}}
	r := NewRelayExecutor(fake)

	_, err := r.ResolveConflict(ctxWithTenant(t), "/repo", "a.txt", "ours")
	if !errors.Is(err, domain.ErrConflictResolveUnsupportedOverRelay) {
		t.Fatalf("expected domain.ErrConflictResolveUnsupportedOverRelay, got %v", err)
	}
	if fake.gotRelay != nil {
		t.Error("expected no RPC call at all — this is a known static limitation, not a runtime probe")
	}
}

func TestRelayExecutor_Discard_SendsWorktreePathAndFilePath(t *testing.T) {
	fake := &fakeInfraFleetServiceClient{relayResp: &infrafleetv1.RelayResponse{}}
	r := NewRelayExecutor(fake)

	if _, err := r.Discard(ctxWithTenant(t), "/repo", "a.txt"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if fake.gotRelay.GetMethod() != "git.discard" {
		t.Errorf("expected method=git.discard, got %q", fake.gotRelay.GetMethod())
	}
	var params map[string]any
	if err := json.Unmarshal([]byte(fake.gotRelay.GetParamsJson()), &params); err != nil {
		t.Fatalf("unmarshal params: %v", err)
	}
	if params["worktreePath"] != "/repo" || params["filePath"] != "a.txt" {
		t.Errorf("unexpected params: %+v", params)
	}
}

func TestRelayExecutor_BulkDiscard_SendsWorktreePathAndFilePaths(t *testing.T) {
	fake := &fakeInfraFleetServiceClient{relayResp: &infrafleetv1.RelayResponse{}}
	r := NewRelayExecutor(fake)

	if _, err := r.BulkDiscard(ctxWithTenant(t), "/repo", []string{"a.txt", "b.txt"}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if fake.gotRelay.GetMethod() != "git.bulkDiscard" {
		t.Errorf("expected method=git.bulkDiscard, got %q", fake.gotRelay.GetMethod())
	}
	var params map[string]any
	if err := json.Unmarshal([]byte(fake.gotRelay.GetParamsJson()), &params); err != nil {
		t.Fatalf("unmarshal params: %v", err)
	}
	filePaths, ok := params["filePaths"].([]any)
	if !ok || len(filePaths) != 2 {
		t.Errorf("unexpected filePaths: %+v", params["filePaths"])
	}
}

// ── TASK-209 real shape redesign: CommitCompare/BranchCompare/CommitDiff/
// BranchDiff/SubmoduleStatus + TASK-210's Fetch ─────────────────────────────

func TestRelayExecutor_CommitCompare_SendsWorktreePathAndCommitID(t *testing.T) {
	resultJSON, err := json.Marshal(map[string]any{
		"summary": map[string]any{
			"commitOid": "deadbeef", "parentOid": "parent123", "compareRef": "deadbee",
			"baseRef": "parent1", "changedFiles": 1, "status": "ready",
		},
		"entries": []map[string]any{{"path": "a.txt", "status": "modified", "added": 1, "removed": 0}},
	})
	if err != nil {
		t.Fatalf("marshal fixture: %v", err)
	}
	fake := &fakeInfraFleetServiceClient{relayResp: &infrafleetv1.RelayResponse{ResultJson: string(resultJSON)}}
	r := NewRelayExecutor(fake)

	got, err := r.CommitCompare(ctxWithTenant(t), "/repo", "deadbeef")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if fake.gotRelay.GetMethod() != "git.commitCompare" {
		t.Errorf("expected method=git.commitCompare, got %q", fake.gotRelay.GetMethod())
	}
	var params map[string]any
	if err := json.Unmarshal([]byte(fake.gotRelay.GetParamsJson()), &params); err != nil {
		t.Fatalf("unmarshal params: %v", err)
	}
	if params["worktreePath"] != "/repo" || params["commitId"] != "deadbeef" {
		t.Errorf("unexpected params: %+v", params)
	}
	if got.CommitOID != "deadbeef" || got.ParentOID != "parent123" || len(got.Entries) != 1 || got.Entries[0].Path != "a.txt" {
		t.Errorf("unexpected result: %+v", got)
	}
}

func TestRelayExecutor_BranchCompare_SendsWorktreePathAndBaseRef(t *testing.T) {
	resultJSON, err := json.Marshal(map[string]any{
		"summary": map[string]any{
			"baseRef": "main", "baseOid": "base1", "compareRef": "feature", "headOid": "head1",
			"mergeBase": "merge1", "changedFiles": 1, "commitsAhead": 1, "status": "ready",
		},
		"entries": []map[string]any{{"path": "a.txt", "status": "added"}},
	})
	if err != nil {
		t.Fatalf("marshal fixture: %v", err)
	}
	fake := &fakeInfraFleetServiceClient{relayResp: &infrafleetv1.RelayResponse{ResultJson: string(resultJSON)}}
	r := NewRelayExecutor(fake)

	got, err := r.BranchCompare(ctxWithTenant(t), "/repo", "main")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if fake.gotRelay.GetMethod() != "git.branchCompare" {
		t.Errorf("expected method=git.branchCompare, got %q", fake.gotRelay.GetMethod())
	}
	var params map[string]any
	if err := json.Unmarshal([]byte(fake.gotRelay.GetParamsJson()), &params); err != nil {
		t.Fatalf("unmarshal params: %v", err)
	}
	if params["worktreePath"] != "/repo" || params["baseRef"] != "main" {
		t.Errorf("unexpected params: %+v", params)
	}
	if got.CompareRef != "feature" || got.CommitsAhead != 1 || len(got.Entries) != 1 {
		t.Errorf("unexpected result: %+v", got)
	}
}

func TestRelayExecutor_CommitDiff_SendsRequiredFilePathAndOptionalParentOid(t *testing.T) {
	resultJSON, err := json.Marshal(map[string]any{
		"kind": "text", "originalContent": "old", "modifiedContent": "new",
	})
	if err != nil {
		t.Fatalf("marshal fixture: %v", err)
	}
	fake := &fakeInfraFleetServiceClient{relayResp: &infrafleetv1.RelayResponse{ResultJson: string(resultJSON)}}
	r := NewRelayExecutor(fake)

	got, err := r.CommitDiff(ctxWithTenant(t), "/repo", "commit1", "parent1", "a.txt", "old-a.txt")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if fake.gotRelay.GetMethod() != "git.commitDiff" {
		t.Errorf("expected method=git.commitDiff, got %q", fake.gotRelay.GetMethod())
	}
	var params map[string]any
	if err := json.Unmarshal([]byte(fake.gotRelay.GetParamsJson()), &params); err != nil {
		t.Fatalf("unmarshal params: %v", err)
	}
	if params["worktreePath"] != "/repo" || params["commitOid"] != "commit1" || params["parentOid"] != "parent1" ||
		params["filePath"] != "a.txt" || params["oldPath"] != "old-a.txt" {
		t.Errorf("unexpected params: %+v", params)
	}
	if got.Kind != "text" || got.OriginalContent != "old" || got.ModifiedContent != "new" {
		t.Errorf("unexpected result: %+v", got)
	}
}

func TestRelayExecutor_CommitDiff_OmitsParentOidAndOldPathWhenEmpty(t *testing.T) {
	fake := &fakeInfraFleetServiceClient{relayResp: &infrafleetv1.RelayResponse{ResultJson: `{"kind":"text"}`}}
	r := NewRelayExecutor(fake)

	if _, err := r.CommitDiff(ctxWithTenant(t), "/repo", "commit1", "", "a.txt", ""); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	var params map[string]any
	if err := json.Unmarshal([]byte(fake.gotRelay.GetParamsJson()), &params); err != nil {
		t.Fatalf("unmarshal params: %v", err)
	}
	if _, ok := params["parentOid"]; ok {
		t.Error("expected parentOid to be omitted when empty (root commit)")
	}
	if _, ok := params["oldPath"]; ok {
		t.Error("expected oldPath to be omitted when empty")
	}
}

func TestRelayExecutor_BranchDiff_SendsBaseRefAndRequiredFilePath(t *testing.T) {
	resultJSON, err := json.Marshal(map[string]any{
		"kind": "text", "originalContent": "", "modifiedContent": "new",
	})
	if err != nil {
		t.Fatalf("marshal fixture: %v", err)
	}
	fake := &fakeInfraFleetServiceClient{relayResp: &infrafleetv1.RelayResponse{ResultJson: string(resultJSON)}}
	r := NewRelayExecutor(fake)

	got, err := r.BranchDiff(ctxWithTenant(t), "/repo", "main", "a.txt", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if fake.gotRelay.GetMethod() != "git.branchDiff" {
		t.Errorf("expected method=git.branchDiff, got %q", fake.gotRelay.GetMethod())
	}
	var params map[string]any
	if err := json.Unmarshal([]byte(fake.gotRelay.GetParamsJson()), &params); err != nil {
		t.Fatalf("unmarshal params: %v", err)
	}
	if params["worktreePath"] != "/repo" || params["baseRef"] != "main" || params["filePath"] != "a.txt" || params["includePatch"] != true {
		t.Errorf("unexpected params: %+v", params)
	}
	if got.ModifiedContent != "new" {
		t.Errorf("unexpected result: %+v", got)
	}
}

func TestRelayExecutor_SubmoduleStatus_SendsWorktreePathSubmodulePathAndArea(t *testing.T) {
	resultJSON, err := json.Marshal(map[string]any{"branch": "main"})
	if err != nil {
		t.Fatalf("marshal fixture: %v", err)
	}
	fake := &fakeInfraFleetServiceClient{relayResp: &infrafleetv1.RelayResponse{ResultJson: string(resultJSON)}}
	r := NewRelayExecutor(fake)

	got, err := r.SubmoduleStatus(ctxWithTenant(t), "/repo", "vendor/lib", "staged")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if fake.gotRelay.GetMethod() != "git.submoduleStatus" {
		t.Errorf("expected method=git.submoduleStatus, got %q", fake.gotRelay.GetMethod())
	}
	var params map[string]any
	if err := json.Unmarshal([]byte(fake.gotRelay.GetParamsJson()), &params); err != nil {
		t.Fatalf("unmarshal params: %v", err)
	}
	if params["worktreePath"] != "/repo" || params["submodulePath"] != "vendor/lib" || params["area"] != "staged" {
		t.Errorf("unexpected params: %+v", params)
	}
	if got.Branch != "main" {
		t.Errorf("unexpected result: %+v", got)
	}
}

func TestRelayExecutor_Fetch_SendsWorktreePathAndOptionalPushTarget(t *testing.T) {
	fake := &fakeInfraFleetServiceClient{relayResp: &infrafleetv1.RelayResponse{ResultJson: `{"success":true}`}}
	r := NewRelayExecutor(fake)

	got, err := r.Fetch(ctxWithTenant(t), "/repo", &domain.PushTargetInput{RemoteName: "origin"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if fake.gotRelay.GetMethod() != "git.fetch" {
		t.Errorf("expected method=git.fetch, got %q", fake.gotRelay.GetMethod())
	}
	var params map[string]any
	if err := json.Unmarshal([]byte(fake.gotRelay.GetParamsJson()), &params); err != nil {
		t.Fatalf("unmarshal params: %v", err)
	}
	pt, ok := params["pushTarget"].(map[string]any)
	if !ok || pt["remoteName"] != "origin" {
		t.Errorf("unexpected pushTarget param: %+v", params)
	}
	if !got.Success {
		t.Errorf("unexpected result: %+v", got)
	}
}

func TestRelayExecutor_Fetch_NilPushTargetOmitsField(t *testing.T) {
	fake := &fakeInfraFleetServiceClient{relayResp: &infrafleetv1.RelayResponse{ResultJson: `{"success":true}`}}
	r := NewRelayExecutor(fake)

	if _, err := r.Fetch(ctxWithTenant(t), "/repo", nil); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	var params map[string]any
	if err := json.Unmarshal([]byte(fake.gotRelay.GetParamsJson()), &params); err != nil {
		t.Fatalf("unmarshal params: %v", err)
	}
	if _, ok := params["pushTarget"]; ok {
		t.Error("expected pushTarget to be omitted when nil")
	}
}

// ── usecase.FilesystemExecutor compile-time guards (TASK-050/051/055) ────

func TestRelayExecutor_ImplementsFilesystemExecutorNotLocalOnly(t *testing.T) {
	// RelayExecutor must satisfy usecase.FilesystemExecutor (fs.* relay
	// methods) but must NOT satisfy usecase.LocalOnlyFilesystemExecutor
	// (Rename/Copy) — the type system is what guarantees
	// RenameFileUseCase/CopyFileUseCase can never be constructed with a
	// relay-backed executor. This test only compiles the positive half;
	// the negative half (RelayExecutor does NOT implement
	// LocalOnlyFilesystemExecutor) is a compile-time property with no
	// runtime assertion available — confirmed manually per TASK-055's
	// verify section.
	var _ usecase.FilesystemExecutor = (*RelayExecutor)(nil)
}

// ── v5.0 dotted-method-name/contract fix: the real agent's
// agent-rpc-dispatch.ts registers these under "git.worktree.list"/
// "git.worktree.remove" (a "v5.0" update, per its own inline comments),
// not the stale camelCase "git.worktreeList"/"git.worktreeRemove" this
// package called before this fix — live-reproduced as WORKTREE_DETECT_FAILED
// on b15.openledger.vn for a genuinely-reachable dev server. ──

func TestRelayExecutor_ListWorktreePaths_SendsCwdAndParsesWorktreesShape(t *testing.T) {
	resultJSON, err := json.Marshal(map[string]any{
		"worktrees": []map[string]any{
			{"path": "/repo", "head": "abc123", "branch": "main"},
			{"path": "/repo/.worktrees/feature", "head": "def456", "branch": "feature"},
		},
	})
	if err != nil {
		t.Fatalf("marshal fixture: %v", err)
	}
	fake := &fakeInfraFleetServiceClient{relayResp: &infrafleetv1.RelayResponse{ResultJson: string(resultJSON)}}
	r := NewRelayExecutor(fake)

	infos, err := r.ListWorktreePaths(ctxWithTenant(t), "/repo")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if fake.gotRelay.GetMethod() != "git.worktree.list" {
		t.Errorf("expected method=git.worktree.list, got %q", fake.gotRelay.GetMethod())
	}
	var params map[string]any
	if err := json.Unmarshal([]byte(fake.gotRelay.GetParamsJson()), &params); err != nil {
		t.Fatalf("unmarshal params: %v", err)
	}
	if params["cwd"] != "/repo" {
		t.Errorf("expected cwd param (agent-git-handler.ts's handleGitWorktreeList reads params.cwd, not params.repoPath), got %+v", params)
	}
	if len(infos) != 2 {
		t.Fatalf("want 2 worktrees, got %d", len(infos))
	}
	if infos[0].Path != "/repo" || infos[0].Head != "abc123" || infos[0].Branch != "main" {
		t.Errorf("unexpected worktree[0]: %+v", infos[0])
	}
	if infos[1].Path != "/repo/.worktrees/feature" || infos[1].Head != "def456" || infos[1].Branch != "feature" {
		t.Errorf("unexpected worktree[1]: %+v", infos[1])
	}
}

// ── CreateWorktree fix: method name was "git.worktreeAdd" (typo — the agent
// only registers the dotted "git.worktree.add"), and the param shape was
// wrong (agent's handleGitWorktreeAdd wants params.path as the NEW
// worktree's destination dir + params.cwd as the EXISTING repo root, not a
// single "repoPath"). git.worktree.add's own reply has no path/HeadSHA, so
// CreateWorktree computes the target path itself (mirrors localgit's
// repoPath + "-" + sanitized-branch convention) and issues a git.exec
// rev-parse HEAD follow-up for HeadSHA. ──

func TestRelayExecutor_CreateWorktree_SendsCorrectMethodAndParams(t *testing.T) {
	worktreeAddResp, err := json.Marshal(map[string]any{"stdout": "", "stderr": "", "exitCode": 0})
	if err != nil {
		t.Fatalf("marshal fixture: %v", err)
	}
	revParseResp, err := json.Marshal(map[string]any{"stdout": "abc123\n", "stderr": "", "exitCode": 0})
	if err != nil {
		t.Fatalf("marshal fixture: %v", err)
	}
	fake := &fakeInfraFleetServiceClient{relayRespByMethod: map[string]*infrafleetv1.RelayResponse{
		"git.worktree.add": {ResultJson: string(worktreeAddResp)},
		"git.exec":         {ResultJson: string(revParseResp)},
	}}
	r := NewRelayExecutor(fake)

	result, err := r.CreateWorktree(ctxWithTenant(t), "/repo", "feature/x", "origin/main")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(fake.gotRelayRequests) != 2 {
		t.Fatalf("want 2 relay calls (git.worktree.add + git.exec), got %d", len(fake.gotRelayRequests))
	}

	addReq := fake.gotRelayRequests[0]
	if addReq.GetMethod() != "git.worktree.add" {
		t.Errorf("expected method=git.worktree.add, got %q", addReq.GetMethod())
	}
	var addParams map[string]any
	if err := json.Unmarshal([]byte(addReq.GetParamsJson()), &addParams); err != nil {
		t.Fatalf("unmarshal params: %v", err)
	}
	wantPath := "/repo-feature-x"
	if addParams["path"] != wantPath {
		t.Errorf("expected path=%q (agent-git-handler.ts's handleGitWorktreeAdd reads params.path as the new worktree's destination), got %+v", wantPath, addParams)
	}
	if addParams["branch"] != "feature/x" {
		t.Errorf("expected branch=feature/x, got %+v", addParams)
	}
	if addParams["createBranch"] != true {
		t.Errorf("expected createBranch=true (CreateWorktreeInput has no checkout-existing-branch signal), got %+v", addParams)
	}
	if addParams["cwd"] != "/repo" {
		t.Errorf("expected cwd=/repo (the EXISTING repo root handleGitWorktreeAdd runs `git worktree add` from), got %+v", addParams)
	}
	if addParams["baseRef"] != "origin/main" {
		t.Errorf("expected baseRef=origin/main, got %+v", addParams)
	}

	revParseReq := fake.gotRelayRequests[1]
	if revParseReq.GetMethod() != "git.exec" {
		t.Errorf("expected method=git.exec, got %q", revParseReq.GetMethod())
	}
	var revParseParams map[string]any
	if err := json.Unmarshal([]byte(revParseReq.GetParamsJson()), &revParseParams); err != nil {
		t.Fatalf("unmarshal params: %v", err)
	}
	if revParseParams["cwd"] != wantPath {
		t.Errorf("expected rev-parse cwd=%q (the NEW worktree dir), got %+v", wantPath, revParseParams)
	}

	if result.Path != wantPath {
		t.Errorf("expected result.Path=%q, got %q", wantPath, result.Path)
	}
	if result.HeadSHA != "abc123" {
		t.Errorf("expected result.HeadSHA=abc123 (trimmed from git.exec's rev-parse HEAD stdout), got %q", result.HeadSHA)
	}
}

func TestRelayExecutor_CreateWorktree_OmitsBaseRefWhenEmpty(t *testing.T) {
	worktreeAddResp, _ := json.Marshal(map[string]any{"stdout": "", "stderr": "", "exitCode": 0})
	revParseResp, _ := json.Marshal(map[string]any{"stdout": "def456\n", "stderr": "", "exitCode": 0})
	fake := &fakeInfraFleetServiceClient{relayRespByMethod: map[string]*infrafleetv1.RelayResponse{
		"git.worktree.add": {ResultJson: string(worktreeAddResp)},
		"git.exec":         {ResultJson: string(revParseResp)},
	}}
	r := NewRelayExecutor(fake)

	if _, err := r.CreateWorktree(ctxWithTenant(t), "/repo", "plain", ""); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	var addParams map[string]any
	if err := json.Unmarshal([]byte(fake.gotRelayRequests[0].GetParamsJson()), &addParams); err != nil {
		t.Fatalf("unmarshal params: %v", err)
	}
	if _, ok := addParams["baseRef"]; ok {
		t.Errorf("expected baseRef omitted when empty, got %+v", addParams)
	}
}

func TestRelayExecutor_RemoveWorktree_SendsPathAndForce(t *testing.T) {
	fake := &fakeInfraFleetServiceClient{relayResp: &infrafleetv1.RelayResponse{ResultJson: "{}"}}
	r := NewRelayExecutor(fake)

	if err := r.RemoveWorktree(ctxWithTenant(t), "/repo/.worktrees/feature", true); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if fake.gotRelay.GetMethod() != "git.worktree.remove" {
		t.Errorf("expected method=git.worktree.remove, got %q", fake.gotRelay.GetMethod())
	}
	var params map[string]any
	if err := json.Unmarshal([]byte(fake.gotRelay.GetParamsJson()), &params); err != nil {
		t.Fatalf("unmarshal params: %v", err)
	}
	if params["path"] != "/repo/.worktrees/feature" || params["force"] != true {
		t.Errorf("expected path+force params (agent-git-handler.ts's handleGitWorktreeRemove reads params.path, not params.worktreePath), got %+v", params)
	}
}

// ── dispatchExecutorForRepo's ctx-carried DevServerID (usecase.WithDevServerID)
// makes relay use RelayByDevServer instead of the connectionId-keyed Relay —
// see relay's own doc comment for why: repoPath was never a valid
// infra.connections.id, so Relay could never have resolved for any caller
// reaching this package via dispatchExecutorForRepo. ──

func TestRelayExecutor_ListWorktreePaths_WithDevServerIDInContext_UsesRelayByDevServer(t *testing.T) {
	resultJSON, err := json.Marshal(map[string]any{
		"worktrees": []map[string]any{{"path": "/repo", "head": "abc123", "branch": "main"}},
	})
	if err != nil {
		t.Fatalf("marshal fixture: %v", err)
	}
	fake := &fakeInfraFleetServiceClient{relayByDevServerResp: &infrafleetv1.RelayResponse{ResultJson: string(resultJSON)}}
	r := NewRelayExecutor(fake)

	ctx := usecase.WithDevServerID(ctxWithTenant(t), "ds-1")
	infos, err := r.ListWorktreePaths(ctx, "/repo")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if fake.gotRelay != nil {
		t.Error("expected the connectionId-keyed Relay RPC NOT to be called when a dev server id is in context")
	}
	if fake.gotRelayByDevServer == nil {
		t.Fatal("expected RelayByDevServer to be called")
	}
	if fake.gotRelayByDevServer.GetDevServerId() != "ds-1" {
		t.Errorf("expected devServerId=ds-1, got %q", fake.gotRelayByDevServer.GetDevServerId())
	}
	if fake.gotRelayByDevServer.GetMethod() != "git.worktree.list" {
		t.Errorf("expected method=git.worktree.list, got %q", fake.gotRelayByDevServer.GetMethod())
	}
	if len(infos) != 1 || infos[0].Path != "/repo" {
		t.Errorf("unexpected result: %+v", infos)
	}
}

// ── TASK-BE-EVM-015: ctx-carried HiddenTargetID (usecase.WithHiddenTargetID)
// makes relay() route via a "ViaHiddenTarget"-suffixed agent method name
// with hiddenTargetId in params — same devServer/RelayByDevServer dispatch
// as any other repo on that Dev Server, no new transport. ──

func TestGitDispatch_HiddenTargetID_RoutesToAgentHiddenTargetMethod(t *testing.T) {
	resultJSON, err := json.Marshal(map[string]any{"branch": "main", "clean": true})
	if err != nil {
		t.Fatalf("marshal fixture: %v", err)
	}
	fake := &fakeInfraFleetServiceClient{relayByDevServerResp: &infrafleetv1.RelayResponse{ResultJson: string(resultJSON)}}
	r := NewRelayExecutor(fake)

	// Mirrors dispatchExecutorForRepo's real ordering: WithDevServerID first
	// (so relay() picks RelayByDevServer at all), then WithHiddenTargetID on
	// top of that same ctx — see that function's real body.
	ctx := usecase.WithDevServerID(ctxWithTenant(t), "ds-1")
	ctx = usecase.WithHiddenTargetID(ctx, "runtime-1")

	if _, err := r.GetStatus(ctx, "/repo"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if fake.gotRelayByDevServer == nil {
		t.Fatal("expected RelayByDevServer to be called")
	}
	if got := fake.gotRelayByDevServer.GetMethod(); got != "git.statusViaHiddenTarget" {
		t.Errorf("expected method=git.statusViaHiddenTarget, got %q", got)
	}

	var params map[string]any
	if err := json.Unmarshal([]byte(fake.gotRelayByDevServer.GetParamsJson()), &params); err != nil {
		t.Fatalf("unmarshal params: %v", err)
	}
	if params["hiddenTargetId"] != "runtime-1" {
		t.Errorf("expected hiddenTargetId=runtime-1 in params, got %+v", params)
	}
	if params["worktreePath"] != "/repo" {
		t.Errorf("expected worktreePath to still be sent unchanged, got %+v", params)
	}
}

func TestGitDispatch_NoHiddenTargetID_UnchangedBehavior(t *testing.T) {
	resultJSON, err := json.Marshal(map[string]any{"branch": "main", "clean": true})
	if err != nil {
		t.Fatalf("marshal fixture: %v", err)
	}
	fake := &fakeInfraFleetServiceClient{relayByDevServerResp: &infrafleetv1.RelayResponse{ResultJson: string(resultJSON)}}
	r := NewRelayExecutor(fake)

	// No WithHiddenTargetID — regression guard: every ordinary repo (not
	// backed by a ssh-type ephemeral VM's hidden target) must keep calling
	// the plain method name with no hiddenTargetId param, exactly as before
	// this task.
	ctx := usecase.WithDevServerID(ctxWithTenant(t), "ds-1")

	if _, err := r.GetStatus(ctx, "/repo"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if fake.gotRelayByDevServer == nil {
		t.Fatal("expected RelayByDevServer to be called")
	}
	if got := fake.gotRelayByDevServer.GetMethod(); got != "git.status" {
		t.Errorf("expected unchanged method=git.status, got %q", got)
	}

	var params map[string]any
	if err := json.Unmarshal([]byte(fake.gotRelayByDevServer.GetParamsJson()), &params); err != nil {
		t.Fatalf("unmarshal params: %v", err)
	}
	if _, present := params["hiddenTargetId"]; present {
		t.Errorf("expected no hiddenTargetId param for an ordinary repo, got %+v", params)
	}
}

// ─── TASK-BE-EVM-018: project.proto's GetRepoResponse.hidden_target_id ────

// fakeProjectServiceClient implements projectv1.ProjectServiceClient
// directly (embed: panics on any unimplemented method) — mirrors
// fakeInfraFleetServiceClient's exact convention above, scoped to just
// GetRepo (the only RPC ProjectClient.GetRepo/this task's test needs).
type fakeProjectServiceClient struct {
	projectv1.ProjectServiceClient

	getRepoResp *projectv1.GetRepoResponse
	getRepoErr  error
}

func (f *fakeProjectServiceClient) GetRepo(ctx context.Context, in *projectv1.GetRepoRequest, _ ...grpc.CallOption) (*projectv1.GetRepoResponse, error) {
	if f.getRepoErr != nil {
		return nil, f.getRepoErr
	}
	return f.getRepoResp, nil
}

// TestGitGatewayRelay_PopulatesHiddenTargetIDFromRepoInfo is TASK-BE-EVM-018's
// required test for Gap 3's project-service half: ProjectClient.GetRepo
// maps project.proto's new GetRepoResponse.hidden_target_id field into
// domain.RepoInfo.HiddenTargetID — closing TASK-BE-EVM-015's gap #2 at the
// wire-mapping level (project-service's own GetRepo handler populating a
// REAL value is a separate, still-open follow-up — see
// domain.RepoInfo.HiddenTargetID's doc comment).
func TestGitGatewayRelay_PopulatesHiddenTargetIDFromRepoInfo(t *testing.T) {
	fake := &fakeProjectServiceClient{
		getRepoResp: &projectv1.GetRepoResponse{
			Repo:           &projectv1.Repo{Id: "repo-1", ProjectId: "proj-1", Url: "https://example.com/repo.git", DisplayName: "repo"},
			DevServerId:    "ds-1",
			HiddenTargetId: "rt-1",
		},
	}
	client := NewProjectClient(fake)

	info, err := client.GetRepo(ctxWithTenant(t), "repo-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if info.HiddenTargetID != "rt-1" {
		t.Errorf("expected HiddenTargetID=rt-1 from the response, got %q", info.HiddenTargetID)
	}
	if info.DevServerID != "ds-1" {
		t.Errorf("expected DevServerID to still map correctly alongside the new field, got %q", info.DevServerID)
	}
}

// TestGitGatewayRelay_NoHiddenTargetID_UnchangedBehavior is the regression
// guard: an ordinary repo (project-service not yet populating
// hidden_target_id — today's universal case) still gets an empty
// HiddenTargetID, not a zero-value panic or a spurious non-empty value.
func TestGitGatewayRelay_NoHiddenTargetID_UnchangedBehavior(t *testing.T) {
	fake := &fakeProjectServiceClient{
		getRepoResp: &projectv1.GetRepoResponse{
			Repo:        &projectv1.Repo{Id: "repo-1", ProjectId: "proj-1", Url: "https://example.com/repo.git"},
			DevServerId: "ds-1",
		},
	}
	client := NewProjectClient(fake)

	info, err := client.GetRepo(ctxWithTenant(t), "repo-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if info.HiddenTargetID != "" {
		t.Errorf("expected empty HiddenTargetID for an ordinary repo, got %q", info.HiddenTargetID)
	}
}
