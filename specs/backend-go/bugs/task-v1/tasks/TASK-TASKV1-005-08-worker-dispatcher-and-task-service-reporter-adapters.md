# TASK-TASKV1-005-08: Adapters — `infrafleetclient.WorkerDispatcher` + `taskserviceclient.TaskServiceReporter`

**From Solution:** SOL-TASKV1-005
**Priority:** P1
**Service:** `orchestration-service` (outbound adapters — `infra-fleet-service` and `task-service` clients)
**File:** `backend-go/services/orchestration-service/internal/adapter/infrafleetclient/worker_dispatcher.go` (new package + file), `backend-go/services/orchestration-service/internal/adapter/taskserviceclient/reporter.go` (new package + file)
**Depends on:** TASK-TASKV1-005-04 (`WorkerDispatcher`/`TaskServiceReporter` ports)
**Status:** `[ ]` TODO

---

## Context

Neither adapter package exists yet — `orchestration-service` today has no
`internal/adapter/infrafleetclient` or `internal/adapter/taskserviceclient`
directory at all (confirmed: `ls internal/adapter/` shows only `grpc` and
`postgres`). `WorkerDispatcher`'s job is dispatching a claimed
`OrchestrationTask` to a terminal-hosted AI-agent worker — this follows
`task-service`'s existing `SimpleExecutor.Execute`
(`services/task-service/internal/adapter/grpcclient/simple_executor.go:132-193`)
relay pattern byte-for-byte: resolve a `connectionId`, call
`infrafleetv1.InfraFleetServiceClient.Relay` with a JSON-marshaled params
struct, unmarshal the JSON result.

`TaskServiceReporter`'s job is calling `task-service`'s
`ReportTaskExecutionResult` RPC — **flagged dependency, same class as
TASK-TG-04-04's**: grep confirms this RPC does not exist anywhere in
`backend-go` yet (`task-service`'s own side is `SOL-TG-04`'s
`TASK-TG-04-05`, not yet built). This task writes the client-side adapter
against the request/response shape `SOL-TG-04` already fixed
(`ReportTaskExecutionResultRequest{TaskID, CoordinatorRunID, Success,
ActualHours, ErrorMessage}`) — confirm `TASK-TG-04-05` lands (or the proto
message exists) before wiring this adapter into
`orchestration-service`'s production composition root, since calling an
RPC with no server implementation fails at dial/call time, not compile
time (same caveat `TASK-TG-04-04`'s own doc comment already states for the
mirror-image dependency).

## Changes to make

Create `backend-go/services/orchestration-service/internal/adapter/infrafleetclient/worker_dispatcher.go`:

```go
// Package infrafleetclient implements orchestration-service's outbound
// WorkerDispatcher port against infra-fleet-service — the only other
// service this one is allowed to dial directly for execution dispatch
// (orchestration-service.md §7).
package infrafleetclient

import (
	"encoding/json"
	"context"
	"fmt"

	infrafleetv1 "github.com/stablyai/orca-go/proto/gen/go/orca/infrafleet/v1"
	"github.com/stablyai/orca-go/services/orchestration-service/internal/domain"
)

// WorkerDispatcher implements usecase.WorkerDispatcher for real — relays a
// dispatch to a terminal-hosted AI-agent worker via infra-fleet-service's
// Relay RPC, following task-service's SimpleExecutor.Execute
// (simple_executor.go:132-193) pattern: this is a call-site reuse of an
// already-proven relay shape, not a new resolution mechanism.
type WorkerDispatcher struct {
	relay infrafleetv1.InfraFleetServiceClient
}

func NewWorkerDispatcher(relay infrafleetv1.InfraFleetServiceClient) *WorkerDispatcher {
	return &WorkerDispatcher{relay: relay}
}

// taskConnectionSpec is the subset of OrchestrationTask.Spec this adapter
// reads — connection targeting is task-service's ProjectExecutionResolver's
// job upstream, already baked into the spec at buildOrchestrationSpec time
// (SOL-TG-04) per orchestration-service.md §7's "does not decide
// decomposition strategy" — this adapter never re-resolves a connection on
// its own.
type taskConnectionSpec struct {
	ConnectionID string `json:"connectionId"`
	WorktreePath string `json:"worktreePath"`
}

// agentExecPromptParams/Result mirror SimpleExecutor's own types
// (simple_executor.go) — same wire shape, same convention, deliberately
// not shared as an exported type across services (each service's client
// package owns its own copy per this codebase's existing precedent of not
// sharing wire-shape structs cross-service outside the generated proto).
type agentExecPromptParams struct {
	Prompt       string `json:"prompt"`
	WorktreePath string `json:"worktreePath"`
	StepID       string `json:"stepId,omitempty"`
}

type agentExecPromptResult struct {
	Stdout   string `json:"stdout"`
	Stderr   string `json:"stderr"`
	ExitCode *int   `json:"exitCode"`
	TimedOut bool   `json:"timedOut"`
}

func (d *WorkerDispatcher) Dispatch(ctx context.Context, tenantID string, task domain.OrchestrationTask, handle string) error {
	var conn taskConnectionSpec
	if err := json.Unmarshal(task.Spec, &conn); err != nil {
		return fmt.Errorf("worker_dispatcher: unmarshal task spec: %w", err)
	}
	if conn.ConnectionID == "" {
		return fmt.Errorf("worker_dispatcher: task %q spec has no connectionId", task.ID)
	}

	paramsJSON, err := json.Marshal(agentExecPromptParams{
		Prompt:       task.TaskTitle,
		WorktreePath: conn.WorktreePath,
		StepID:       handle,
	})
	if err != nil {
		return fmt.Errorf("worker_dispatcher: marshal params: %w", err)
	}
	resp, err := d.relay.Relay(ctx, &infrafleetv1.RelayRequest{
		ConnectionId: conn.ConnectionID, Method: "agent.execPrompt", ParamsJson: string(paramsJSON),
	})
	if err != nil {
		return fmt.Errorf("worker_dispatcher: relay agent.execPrompt: %w", err)
	}
	var result agentExecPromptResult
	if err := json.Unmarshal([]byte(resp.GetResultJson()), &result); err != nil {
		return fmt.Errorf("worker_dispatcher: unmarshal agent.execPrompt result: %w", err)
	}
	if result.TimedOut {
		return fmt.Errorf("worker_dispatcher: agent.execPrompt timed out for task %q", task.ID)
	}
	if result.ExitCode == nil || *result.ExitCode != 0 {
		return fmt.Errorf("worker_dispatcher: agent.execPrompt exited non-zero for task %q: %s", task.ID, result.Stderr)
	}
	return nil
}
```

Create `backend-go/services/orchestration-service/internal/adapter/taskserviceclient/reporter.go`:

```go
// Package taskserviceclient implements orchestration-service's outbound
// TaskServiceReporter port against task-service — the SERVER side
// (ReportTaskExecutionResult) is task-service's own scope, SOL-TG-04's
// TASK-TG-04-05. This package is only the CLIENT stub calling it.
package taskserviceclient

import (
	"context"
	"fmt"

	taskv1 "github.com/stablyai/orca-go/proto/gen/go/orca/task/v1"
)

// Reporter implements usecase.TaskServiceReporter for real. FLAGGED
// DEPENDENCY: taskv1.ReportTaskExecutionResultRequest/the RPC method do
// not exist in the generated proto as of this writing (grep confirms zero
// ReportTaskExecutionResult matches anywhere in backend-go) — this file
// assumes TASK-TG-04-05's shape
// (ReportTaskExecutionResultRequest{TaskID, CoordinatorRunID, Success,
// ActualHours, ErrorMessage}) lands first; go build will fail on this
// file until that proto message/RPC exists. Do not wire this adapter into
// cmd/server/main.go's production composition root (TASK-TASKV1-005-09)
// until TASK-TG-04-05 is confirmed landed or scheduled immediately ahead
// of it.
type Reporter struct {
	tasks taskv1.TaskServiceClient
}

func NewReporter(tasks taskv1.TaskServiceClient) *Reporter {
	return &Reporter{tasks: tasks}
}

func (r *Reporter) ReportResult(ctx context.Context, taskID, coordinatorRunID string, success bool, errMsg string) error {
	_, err := r.tasks.ReportTaskExecutionResult(ctx, &taskv1.ReportTaskExecutionResultRequest{
		TaskId:           taskID,
		CoordinatorRunId: coordinatorRunID,
		Success:          success,
		ErrorMessage:     errMsg,
	})
	if err != nil {
		return fmt.Errorf("taskserviceclient: report task execution result: %w", err)
	}
	return nil
}
```

## Verify

```bash
cd /opt/repos/orca/backend-go
go build ./services/orchestration-service/internal/adapter/infrafleetclient/...
# The following will only succeed once TASK-TG-04-05 (task-service's
# ReportTaskExecutionResult RPC) has landed in the generated proto —
# expected to fail today, tracked as this task's flagged dependency:
go build ./services/orchestration-service/internal/adapter/taskserviceclient/...
```

Write `worker_dispatcher_test.go` (fake `InfraFleetServiceClient`, same
style `simple_executor_test.go` uses for its fake): a task whose `Spec`
carries a valid `connectionId`/`worktreePath` dispatches successfully; a
missing `connectionId` returns an error without calling `Relay`; a
non-zero `exitCode`/`timedOut` result surfaces as an error. Write
`reporter_test.go` once `TASK-TG-04-05` lands (fake `TaskServiceClient`):
`ReportResult` maps `success`/`errMsg` onto the request fields correctly;
a gRPC error from the fake surfaces wrapped, not swallowed.
