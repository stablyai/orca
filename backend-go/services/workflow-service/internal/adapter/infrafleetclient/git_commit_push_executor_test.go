package infrafleetclient

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"google.golang.org/grpc"

	infrafleetv1 "github.com/stablyai/orca-go/proto/gen/go/orca/infrafleet/v1"
	"github.com/stablyai/orca-go/services/workflow-service/internal/domain"
)

func TestGitCommitPushExecutor_CommitsThenPushesByDefault(t *testing.T) {
	var calledMethods []string
	fake := &fakeInfraFleetClient{
		relayFunc: func(_ context.Context, in *infrafleetv1.RelayRequest, _ ...grpc.CallOption) (*infrafleetv1.RelayResponse, error) {
			calledMethods = append(calledMethods, in.Method)
			switch in.Method {
			case "git.commit":
				result, _ := json.Marshal(map[string]any{"success": true})
				return &infrafleetv1.RelayResponse{ResultJson: string(result)}, nil
			case "git.push":
				result, _ := json.Marshal(map[string]any{"success": true})
				return &infrafleetv1.RelayResponse{ResultJson: string(result)}, nil
			}
			return nil, errors.New("unexpected method " + in.Method)
		},
	}
	exec := NewGitCommitPushExecutor(fake)
	ctx := withTenantContext(context.Background(), "tenant-1")

	cfg, _ := json.Marshal(domain.CommitPushStepConfig{ConnectionID: "conn-1", Message: "chore: automated cleanup"})
	result, err := exec.Execute(ctx, string(cfg))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Status != domain.ResultStatusCompleted {
		t.Fatalf("expected completed status, got %v (output=%s)", result.Status, result.OutputJSON)
	}
	if len(calledMethods) != 2 || calledMethods[0] != "git.commit" || calledMethods[1] != "git.push" {
		t.Fatalf("expected git.commit then git.push, got %v", calledMethods)
	}
	var out map[string]any
	if err := json.Unmarshal([]byte(result.OutputJSON), &out); err != nil {
		t.Fatalf("unmarshal output: %v", err)
	}
	if out["committed"] != true || out["pushed"] != true {
		t.Errorf("unexpected output: %+v", out)
	}
}

func TestGitCommitPushExecutor_PushFalseSkipsPush(t *testing.T) {
	var calledMethods []string
	fake := &fakeInfraFleetClient{
		relayFunc: func(_ context.Context, in *infrafleetv1.RelayRequest, _ ...grpc.CallOption) (*infrafleetv1.RelayResponse, error) {
			calledMethods = append(calledMethods, in.Method)
			result, _ := json.Marshal(map[string]any{"success": true})
			return &infrafleetv1.RelayResponse{ResultJson: string(result)}, nil
		},
	}
	exec := NewGitCommitPushExecutor(fake)
	ctx := withTenantContext(context.Background(), "tenant-1")

	push := false
	cfg, _ := json.Marshal(domain.CommitPushStepConfig{ConnectionID: "conn-1", Message: "m", Push: &push})
	result, err := exec.Execute(ctx, string(cfg))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Status != domain.ResultStatusCompleted {
		t.Fatalf("expected completed status, got %v", result.Status)
	}
	if len(calledMethods) != 1 || calledMethods[0] != "git.commit" {
		t.Fatalf("expected only git.commit (push:false), got %v", calledMethods)
	}
}

func TestGitCommitPushExecutor_CommitFailure_NeverCallsPush(t *testing.T) {
	var calledMethods []string
	fake := &fakeInfraFleetClient{
		relayFunc: func(_ context.Context, in *infrafleetv1.RelayRequest, _ ...grpc.CallOption) (*infrafleetv1.RelayResponse, error) {
			calledMethods = append(calledMethods, in.Method)
			result, _ := json.Marshal(map[string]any{"success": false, "error": "nothing to commit, working tree clean"})
			return &infrafleetv1.RelayResponse{ResultJson: string(result)}, nil
		},
	}
	exec := NewGitCommitPushExecutor(fake)
	ctx := withTenantContext(context.Background(), "tenant-1")

	cfg, _ := json.Marshal(domain.CommitPushStepConfig{ConnectionID: "conn-1", Message: "m"})
	result, err := exec.Execute(ctx, string(cfg))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Status != domain.ResultStatusFailed {
		t.Fatalf("expected failed status (commit reported success:false), got %v", result.Status)
	}
	if len(calledMethods) != 1 || calledMethods[0] != "git.commit" {
		t.Fatalf("git.push must never be called after a failed commit, got calls: %v", calledMethods)
	}
	var out map[string]any
	_ = json.Unmarshal([]byte(result.OutputJSON), &out)
	if out["error"] != "nothing to commit, working tree clean" {
		t.Errorf("expected commit's error message surfaced in output, got %+v", out)
	}
}

func TestGitCommitPushExecutor_PushRelayErrorStillReportsCommitted(t *testing.T) {
	fake := &fakeInfraFleetClient{
		relayFunc: func(_ context.Context, in *infrafleetv1.RelayRequest, _ ...grpc.CallOption) (*infrafleetv1.RelayResponse, error) {
			if in.Method == "git.commit" {
				result, _ := json.Marshal(map[string]any{"success": true})
				return &infrafleetv1.RelayResponse{ResultJson: string(result)}, nil
			}
			return nil, errors.New("dev server unreachable")
		},
	}
	exec := NewGitCommitPushExecutor(fake)
	ctx := withTenantContext(context.Background(), "tenant-1")

	cfg, _ := json.Marshal(domain.CommitPushStepConfig{ConnectionID: "conn-1", Message: "m"})
	result, err := exec.Execute(ctx, string(cfg))
	if err != nil {
		t.Fatalf("unexpected error: %v (push transport failures are a business-level StepResult, not a Go error)", err)
	}
	if result.Status != domain.ResultStatusFailed {
		t.Fatalf("expected failed status, got %v", result.Status)
	}
	var out map[string]any
	if err := json.Unmarshal([]byte(result.OutputJSON), &out); err != nil {
		t.Fatalf("unmarshal output: %v", err)
	}
	if out["committed"] != true {
		t.Errorf("expected committed:true even though push failed, got %+v", out)
	}
	if out["pushed"] != false {
		t.Errorf("expected pushed:false, got %+v", out)
	}
}

func TestGitCommitPushExecutor_CommitRelayErrorPropagates(t *testing.T) {
	fake := &fakeInfraFleetClient{
		relayFunc: func(_ context.Context, _ *infrafleetv1.RelayRequest, _ ...grpc.CallOption) (*infrafleetv1.RelayResponse, error) {
			return nil, errors.New("dev server unreachable")
		},
	}
	exec := NewGitCommitPushExecutor(fake)
	ctx := withTenantContext(context.Background(), "tenant-1")

	cfg, _ := json.Marshal(domain.CommitPushStepConfig{ConnectionID: "conn-1", Message: "m"})
	_, err := exec.Execute(ctx, string(cfg))
	if err == nil {
		t.Fatal("expected the git.commit relay transport error to propagate as a Go error")
	}
}
