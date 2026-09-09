package infrafleetclient

import (
	"context"
	"encoding/json"
	"fmt"

	infrafleetv1 "github.com/stablyai/orca-go/proto/gen/go/orca/infrafleet/v1"
	"github.com/stablyai/orca-go/services/workflow-service/internal/domain"
)

// gitCommitResult mirrors agent's commitChangesRelay return shape
// (agent/src/relay/git-handler-worktree-ops.ts) — confirmed by reading that
// file directly, not assumed: unlike ShellExecutor/AgentExecutor's
// "best-effort, unverified" siblings, commitChangesRelay NEVER throws —
// every failure path (empty message, git commit error) returns
// {success:false, error} as a normal JSON-RPC result, never a JSON-RPC
// error. A commit failure is therefore a business-level StepResult failure
// here, the same distinction execResult draws for a non-zero exitCode —
// not a relay/transport error.
type gitCommitResult struct {
	Success bool   `json:"success"`
	Error   string `json:"error,omitempty"`
}

// gitPushResult mirrors agent's handleGitPush (agent/src/relay/agent-git-handler-remote-ops.ts):
// the happy path returns {success:true}; failures throw agent-side and
// surface as a JSON-RPC error (a relay() transport error here), never a
// {success:false} result — unlike commit. gitCommitPushOutput below still
// carries a Success field for the happy path's OutputJSON, kept symmetric
// with gitCommitResult for a caller reading action_results_json.
type gitPushResult struct {
	Success bool `json:"success"`
}

// gitCommitPushOutput is what Execute marshals into StepResult.OutputJSON —
// mirrors execResultOutput's shape convention (structured, not just the
// raw agent response) for whichever of commit/push actually ran.
type gitCommitPushOutput struct {
	Committed bool   `json:"committed"`
	Pushed    bool   `json:"pushed"`
	Error     string `json:"error,omitempty"`
}

// GitCommitPushExecutor is the real CommitPush step executor —
// CR-AUTO-003/TASK-BE-AUTO-005. Relays git.commit (agent/src/relay/agent-git-handler-local-ops.ts's
// handleGitCommit) then, if Push isn't explicitly false, git.push
// (agent-git-handler-remote-ops.ts's handleGitPush) to infra-fleet-service's
// Relay RPC — same relay() primitive ShellExecutor/NotificationExecutor
// already use, no new transport.
//
// Deliberately does NOT shell out `git commit`/`git push` via
// StepTypeShell: AGENTS.md's "Git Binary Compatibility" section requires
// version-aware fallback handling (GitCapabilityCache) for git commands,
// which agent's git.commit/git.push handlers already provide internally —
// reusing them here, not reimplementing that logic as a raw shell string.
type GitCommitPushExecutor struct {
	client infrafleetv1.InfraFleetServiceClient
}

func NewGitCommitPushExecutor(client infrafleetv1.InfraFleetServiceClient) *GitCommitPushExecutor {
	return &GitCommitPushExecutor{client: client}
}

var _ domain.StepExecutor = (*GitCommitPushExecutor)(nil)

func (e *GitCommitPushExecutor) Execute(ctx context.Context, stepConfigJSON string) (domain.StepResult, error) {
	var cfg domain.CommitPushStepConfig
	if err := json.Unmarshal([]byte(stepConfigJSON), &cfg); err != nil {
		return domain.StepResult{}, fmt.Errorf("infrafleetclient: commit_push: invalid step config JSON: %w", err)
	}

	var commitResult gitCommitResult
	if err := relay(ctx, e.client, cfg.ConnectionID, "git.commit", map[string]any{
		"message": cfg.Message,
	}, &commitResult); err != nil {
		return domain.StepResult{}, fmt.Errorf("infrafleetclient: commit_push: git.commit: %w", err)
	}
	if !commitResult.Success {
		return toCommitPushResult(gitCommitPushOutput{Committed: false, Pushed: false, Error: commitResult.Error})
	}

	push := cfg.Push == nil || *cfg.Push // default true — see CommitPushStepConfig's doc comment
	if !push {
		return toCommitPushResult(gitCommitPushOutput{Committed: true, Pushed: false})
	}

	var pushResult gitPushResult
	if err := relay(ctx, e.client, cfg.ConnectionID, "git.push", map[string]any{}, &pushResult); err != nil {
		// git.push failing after a successful commit is still a distinct,
		// useful outcome to report — committed:true, pushed:false, not a
		// bare transport error that discards the fact the commit landed.
		return toCommitPushResult(gitCommitPushOutput{Committed: true, Pushed: false, Error: err.Error()})
	}
	return toCommitPushResult(gitCommitPushOutput{Committed: true, Pushed: true})
}

func toCommitPushResult(out gitCommitPushOutput) (domain.StepResult, error) {
	status := domain.ResultStatusCompleted
	if out.Error != "" {
		status = domain.ResultStatusFailed
	}
	marshaled, err := json.Marshal(out)
	if err != nil {
		return domain.StepResult{}, fmt.Errorf("infrafleetclient: commit_push: marshal output: %w", err)
	}
	return domain.StepResult{Status: status, OutputJSON: string(marshaled)}, nil
}
