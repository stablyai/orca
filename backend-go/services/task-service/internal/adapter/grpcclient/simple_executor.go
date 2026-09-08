package grpcclient

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/stablyai/orca-go/common/apperrors"
	infrafleetv1 "github.com/stablyai/orca-go/proto/gen/go/orca/infrafleet/v1"
	"github.com/stablyai/orca-go/services/task-service/internal/domain"
	"github.com/stablyai/orca-go/services/task-service/internal/usecase"
)

// SimpleExecutor implements usecase.SimpleExecutor for real (TASK-224),
// replacing the prior StubSimpleExecutor — dispatches Execute's simple path
// to infra-fleet-service's Relay RPC. See task-service.md §3.1 and
// TASK-224's Context note for why task-service goes through
// infra-fleet-service rather than dialing the Dev Server Agent itself
// (task-service.md §2/§3.1's "only two Go services that talk to the
// execution plane" rule — infra-fleet-service and git-gateway-service —
// task-service isn't one of them).
//
// TASK-224 Gap 1, closed: relays via "agent.execPrompt", not "agent.exec".
// Read both RPC handlers in full in agent/src/relay/agent-rpc-dispatch.ts
// before making this switch:
//   - case 'agent.exec' (agent-rpc-dispatch.ts:913-982): a generic
//     "run this literal binary" primitive — params
//     {binary(required), args?, cwd?, stdin?, env?, timeoutMs?}, result
//     {stdout, stderr, exitCode, timedOut}. Its own doc comment says its
//     real callers are "StepExecutors.executeAgent() via
//     relay.call('agent.exec', ...)" and "ProfileAwareAgentSpawner" — but
//     that comment is stale: reading the real TS source
//     (backend/src/main/workflow/StepExecutors.ts:1-19,114-124) shows it
//     was rewritten to call 'agent.execPrompt' instead, specifically
//     because "agent.exec IS a real agent RPC — just a different one: a
//     generic {binary,args,cwd,stdin,env,timeoutMs} process-exec call with
//     no prompt/model/trustPreset concept — sending this step's
//     domain-shaped payload to it always failed with InvalidParams."
//   - case 'agent.execPrompt' (agent-rpc-dispatch.ts:992-1000) delegates to
//     handleAgentExecPrompt (agent-print-mode-exec.ts:33-178), which is the
//     real "dispatch an AI-driven task" handler: required params
//     `prompt` (string) and `worktreePath` (string, becomes the spawned
//     CLI's cwd) — see agent-print-mode-exec.ts:39-73's destructuring +
//     validation. Optional: `stepId` (echoed back, used for tracing),
//     `trustPreset` ("full" appends the YOLO flag, anything else is a
//     no-op — agent-print-mode-exec.ts:44,97-99), `model` (defaults to
//     "claude" when absent or empty — agent-print-mode-exec.ts:45; only
//     "claude"-prefixed models are supported for one-shot exec today,
//     agent-print-mode-exec.ts:76-94), `accountId` (agent-print-mode-exec.ts:46,
//     109-116 — buildAgentEnv errors if set but no resolvedApiKey is
//     forwarded, which no live caller does yet; omitted here relies on the
//     CLI's own already-authenticated state, same as every other caller),
//     `env`, `timeoutMs`. Result:
//     {stdout, stderr, exitCode, timedOut, stepId} — no `executionRef`
//     field exists on EITHER method's real result shape (the prior
//     "agent.exec" wiring's `{executionRef}` unmarshal target was already a
//     fabrication, not something either RPC actually returns).
//   - The real, already-proven param-construction pattern is
//     StepExecutors.executeAgent() (backend/src/main/workflow/StepExecutors.ts:101-131):
//     `relay.call('agent.execPrompt', { stepId, prompt, worktreePath,
//     trustPreset: step.config['trustPreset'] ?? 'default', traceId,
//     ...(resolved ? { accountId: resolved.accountId, model: resolved.model } : {}) })`
//     — accountId/model are omitted ENTIRELY (not even as undefined keys)
//     "when no override AND no scope match ... the dev server's agent.exec
//     handler then falls back to its own pre-fix default account,
//     preserving current behavior for workflows that never pin a
//     provider" (StepExecutors.ts:120-122). SimpleExecutor follows that
//     same omit-when-unresolved convention below: task-service has no
//     per-task AI-provider-account pin today (unlike AIDecompose, this
//     path never calls AIProviderContextResolver), so accountId/model are
//     left out of the params entirely rather than guessed at.
//
// worktreePath resolution: infra-fleet-service's ResolveConnectionResponse
// already carries a repo_path field for exactly this purpose (see
// usecase.ProjectExecutionResolver's doc comment and
// ProjectExecutionResolver.ResolveConnection's implementation, which reads
// resp.GetRepoPath() — the same field git-gateway-service's
// ConnectionResolver reads for its own GitExecutor's cwd equivalent,
// internal/usecase/ports.go:26-37 in that service).
//
// prompt construction: this codebase's one existing AI-task-execution
// prompt-building convention is AIDecompose's buildDecomposePrompt
// (ai_decompose.go) — plain text naming the task's title, no structured
// (JSON) request format, because there is no live agent contract yet to
// confirm one against. buildExecutePrompt below follows that same
// plain-text convention for consistency, not a new one invented here.
//
// Honest limit carried over unchanged, not solved by this task:
// task-service still has no execution-completion callback. Unlike
// agent.exec's original (never-real) `executionRef` sketch,
// agent.execPrompt actually blocks until the CLI process exits (or times
// out, up to 15 minutes — agent-print-mode-exec.ts's MAX_TIMEOUT_MS) and
// returns its exit status synchronously in the same RPC response. This
// method therefore synthesizes its own executionRef from taskID+requestID
// (no ID of that kind exists in agent.execPrompt's result to reuse) and
// surfaces a non-zero exit / timeout as a real error rather than an
// "executionRef" pointing at a run that already finished.
type SimpleExecutor struct {
	tasks    usecase.TaskRepository
	resolver usecase.ProjectExecutionResolver
	relay    infrafleetv1.InfraFleetServiceClient
}

func NewSimpleExecutor(tasks usecase.TaskRepository, resolver usecase.ProjectExecutionResolver, relay infrafleetv1.InfraFleetServiceClient) *SimpleExecutor {
	return &SimpleExecutor{tasks: tasks, resolver: resolver, relay: relay}
}

// agentExecPromptParams mirrors agent-print-mode-exec.ts's handled fields —
// see this file's doc comment for the exact source citation. stepId/
// trustPreset/model/accountId are `omitempty`: SimpleExecutor has no value
// to put in the latter two (see the doc comment's "omit when unresolved"
// note), and an empty stepId/trustPreset should vanish from the JSON the
// same way StepExecutors.ts's spread omits accountId/model, not be sent as
// an explicit empty string.
type agentExecPromptParams struct {
	Prompt       string `json:"prompt"`
	WorktreePath string `json:"worktreePath"`
	StepID       string `json:"stepId,omitempty"`
}

// agentExecPromptResult mirrors agent-print-mode-exec.ts's real
// PrintModeExecResult shape (agent-print-mode-exec.ts:25-31,177) — no
// executionRef field exists on the real RPC; see this file's doc comment.
type agentExecPromptResult struct {
	Stdout   string `json:"stdout"`
	Stderr   string `json:"stderr"`
	ExitCode *int   `json:"exitCode"`
	TimedOut bool   `json:"timedOut"`
}

func (s *SimpleExecutor) Execute(ctx context.Context, tenantID, taskID, requestID, prompt string) (string, error) {
	task, err := s.tasks.Get(ctx, tenantID, taskID)
	if err != nil {
		return "", fmt.Errorf("simple_executor: load task: %w", err)
	}
	connectionID, worktreePath, connected, err := s.resolver.ResolveConnection(ctx, tenantID, task.ProjectID)
	if err != nil {
		return "", fmt.Errorf("simple_executor: resolve connection: %w", err)
	}
	if !connected {
		// Per git-gateway-service.md §8's precedent: a resolve failure or
		// not-connected connectionId is a real error, never a silent local
		// fallback — task-service has no local agent.execPrompt equivalent
		// of its own (unlike git-gateway-service's §2 step 3, there is no
		// "this service's own host" case for task execution).
		return "", apperrors.New(apperrors.KindFailedPrecondition, "TASK_EXECUTE_NO_CONNECTION", "task's project has no connected dev server", nil)
	}
	if worktreePath == "" {
		// agent.execPrompt requires worktreePath (agent-print-mode-exec.ts:62-73
		// rejects a missing one with InvalidParams) — a connected connection
		// with no repo_path recorded is a distinct, real error, not a
		// silent no-op dispatch.
		return "", apperrors.New(apperrors.KindFailedPrecondition, "TASK_EXECUTE_NO_WORKTREE_PATH", "task's connected dev server has no worktree path recorded", nil)
	}

	effectivePrompt := prompt
	if effectivePrompt == "" {
		effectivePrompt = buildExecutePrompt(task)
	}
	paramsJSON, err := json.Marshal(agentExecPromptParams{
		Prompt:       effectivePrompt,
		WorktreePath: worktreePath,
		StepID:       requestID,
	})
	if err != nil {
		return "", fmt.Errorf("simple_executor: marshal params: %w", err)
	}
	resp, err := s.relay.Relay(ctx, &infrafleetv1.RelayRequest{
		ConnectionId: connectionID, Method: "agent.execPrompt", ParamsJson: string(paramsJSON),
	})
	if err != nil {
		return "", fmt.Errorf("simple_executor: relay agent.execPrompt: %w", err)
	}
	var result agentExecPromptResult
	if err := json.Unmarshal([]byte(resp.GetResultJson()), &result); err != nil {
		return "", fmt.Errorf("simple_executor: unmarshal agent.execPrompt result: %w", err)
	}
	if result.TimedOut {
		return "", apperrors.New(apperrors.KindInternal, "TASK_EXECUTE_TIMED_OUT", "agent.execPrompt timed out before the task finished", nil)
	}
	if result.ExitCode == nil || *result.ExitCode != 0 {
		return "", apperrors.New(apperrors.KindInternal, "TASK_EXECUTE_FAILED", fmt.Sprintf("agent.execPrompt exited non-zero: %s", result.Stderr), nil)
	}
	return fmt.Sprintf("task-exec:%s:%s", taskID, requestID), nil
}

// buildExecutePrompt assembles the agent.execPrompt prompt from task — see
// this file's doc comment for why this follows ai_decompose.go's
// buildDecomposePrompt plain-text convention rather than a new one.
func buildExecutePrompt(task domain.Task) string {
	var b strings.Builder
	b.WriteString("Complete the following task.\n\n")
	b.WriteString("Task: ")
	b.WriteString(task.Title)
	return b.String()
}
