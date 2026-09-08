# TASK-FT-002-03: `WorkflowExecutor` (Engine 3 client) + `selectEngine`'s `EngineWorkflow` dispatch wiring

**From Solution:** BE-SOL-002
**Priority:** P0
**Service:** `task-service`
**File:** `backend-go/services/task-service/internal/usecase/ports.go` (new `WorkflowExecutor` port), `backend-go/services/task-service/internal/adapter/grpcclient/workflow_executor.go` (new), `backend-go/services/task-service/internal/usecase/execute_task.go` (Engine 3 dispatch branch, replaces TASK-FT-001-03's placeholder), `backend-go/services/task-service/cmd/server/main.go` (dial `workflow-service`), `backend-go/services/task-service/internal/config/config.go` (new `WorkflowServiceAddr`)
**Depends on:** TASK-FT-002-01 (proto), TASK-FT-001-03 (the `EngineWorkflow` placeholder branch this task replaces)
**Status:** `[ ]` TODO

---

## Context

Same port shape as `SimpleExecutor`/`ComplexExecutor`'s existing ports
(`ports.go:119-121`, `:129-131`) — a new port + `internal/adapter/grpcclient/`
file, not a variant of either existing one. `task-service`'s composition
root already has an established `Dial(addr string) (*grpc.ClientConn,
error)` helper (`internal/adapter/grpcclient/dial.go`, real, current) used
identically for `infra-fleet-service`/`ai-provider-service`
(`cmd/server/main.go:89-105`) — this task follows that exact pattern for a
third downstream dial, `workflow-service`.

## Changes to make

**1. `internal/usecase/ports.go`** — new port:

```go
// WorkflowExecutor relays Execute's Engine 3 dispatch to workflow-service,
// per CR-FLOW-TASK-002/BE-SOL-002. Same shape as SimpleExecutor/
// ComplexExecutor — a new port, not a variant of either.
type WorkflowExecutor interface {
	Execute(ctx context.Context, tenantID, taskID, requestID, workflowTemplateID string) (executionRef string, err error)
}
```

**2. New `internal/adapter/grpcclient/workflow_executor.go`:**

```go
package grpcclient

import (
	"context"
	"fmt"

	workflowv1 "github.com/stablyai/orca-go/proto/gen/go/orca/workflow/v1"
)

// WorkflowExecutor implements usecase.WorkflowExecutor against
// workflow-service's real Execute RPC. Unlike StubComplexExecutor, this
// has no stub phase — workflow-service.Execute is real, current code
// (execute.go:70-126), so this client can be wired for real from the
// start.
type WorkflowExecutor struct {
	workflow workflowv1.WorkflowServiceClient
}

func NewWorkflowExecutor(workflow workflowv1.WorkflowServiceClient) *WorkflowExecutor {
	return &WorkflowExecutor{workflow: workflow}
}

// Execute's project_id/root_trace_id are left unset — task-service has no
// ProjectID-to-workflow-inputs mapping designed yet, and interpolating
// task.title/description into workflow inputs is workflow-service's own
// open gap (BUG-WF-02), not invented inline here. Matches
// CR-FLOW-TASK-002's explicit "if input interpolation isn't implemented
// yet, empty inputs, don't block this CR" instruction.
func (w *WorkflowExecutor) Execute(ctx context.Context, tenantID, taskID, requestID, workflowTemplateID string) (string, error) {
	resp, err := w.workflow.Execute(ctx, &workflowv1.ExecuteRequest{
		TemplateId: workflowTemplateID,
		RequestId:  requestID,
		OriginTaskId: taskID,
	})
	if err != nil {
		return "", fmt.Errorf("workflow_executor: execute: %w", err)
	}
	return resp.GetExecution().GetId(), nil
}
```

Confirm `ExecuteResponse`'s exact accessor (`GetExecution().GetId()` above
assumes the same `ExecuteResponse{execution WorkflowExecution}` shape
`workflow.proto`'s current `ExecuteResponse` message uses — verify this
against the regenerated `workflow.pb.go` from TASK-FT-002-01 before
wiring, rather than assuming the accessor name).

**3. `internal/usecase/execute_task.go`** — replace TASK-FT-001-03's
placeholder `EngineWorkflow` branch:

```go
type ExecuteTask struct {
	repo     TaskRepository
	edges    EdgeRepository
	simple   SimpleExecutor
	complex  ComplexExecutor
	workflow WorkflowExecutor
	links    ExecutionLinkRepository
}

func NewExecuteTask(repo TaskRepository, edges EdgeRepository, simple SimpleExecutor, complex ComplexExecutor, workflow WorkflowExecutor, links ExecutionLinkRepository) *ExecuteTask {
	return &ExecuteTask{repo: repo, edges: edges, simple: simple, complex: complex, workflow: workflow, links: links}
}
```

```go
	switch engine {
	case domain.EngineOrchestration:
		ref, err = uc.complex.Execute(ctx, tenantID, in.TaskID, in.RequestID)
	case domain.EngineWorkflow:
		ref, err = uc.workflow.Execute(ctx, tenantID, in.TaskID, in.RequestID, task.WorkflowTemplateID)
	default: // domain.EngineDirectAgent
		ref, err = uc.simple.Execute(ctx, tenantID, in.TaskID, in.RequestID)
	}
```

Per CR-FLOW-TASK-002's explicit instruction, `Execute` returns immediately
for Engine 3 — the same `Async: true` shape the complex path uses, since
`workflow-service`'s real `Execute` (`execute.go:70-126`, confirmed by
reading the file directly) already dispatches its wave loop on a detached
goroutine (`go uc.runToCompletion(dispatchCtx, exec, waves)`,
`execute.go:123`) and returns `exec` (status `pending`/`running`) well
before the DAG finishes — this is not an assumption, it is the real,
current, confirmed behavior of the RPC this executor calls.

**4. `cmd/server/main.go`** — dial `workflow-service`, identical shape to
the existing `infra-fleet-service`/`ai-provider-service` dials
(`main.go:89-105`):

```go
workflowConn, err := taskgrpcclient.Dial(cfg.WorkflowServiceAddr)
if err != nil {
	return fmt.Errorf("dialing workflow-service: %w", err)
}
defer func() { _ = workflowConn.Close() }()
workflowClient := workflowv1.NewWorkflowServiceClient(workflowConn)
workflowExecutor := taskgrpcclient.NewWorkflowExecutor(workflowClient)
```

```go
executeTaskUC := usecase.NewExecuteTask(repo, repo, simpleExecutor, complexExecutor, workflowExecutor, repo)
```

Add `workflowv1 "github.com/stablyai/orca-go/proto/gen/go/orca/workflow/v1"`
to the import block alongside the existing `infrafleetv1`/`aiproviderv1`
imports (`main.go:36-38`).

**5. `internal/config/config.go`** — add `WorkflowServiceAddr string`,
same convention as the existing `InfraFleetServiceAddr`/
`AIProviderServiceAddr` fields (confirmed present at `config.go:20-26`):

```go
WorkflowServiceAddr string
```

```go
WorkflowServiceAddr: commonconfig.StringEnv("WORKFLOW_SERVICE_ADDR", "workflow-service:9090"),
```

## Verify

```bash
cd /opt/repos/orca/backend-go
go build ./...
go test ./services/task-service/internal/adapter/grpcclient/... -run TestWorkflowExecutor -v
go test ./services/task-service/internal/usecase/... -run TestExecuteTask -v
```

Expected: clean build; a fake `WorkflowServiceClient` confirms `Execute`
forwards `OriginTaskId`/`TemplateId` correctly and returns the execution
id from the response; `ExecuteTask`'s `EngineWorkflow` branch case
(extended in TASK-FT-001-04) now calls `WorkflowExecutor.Execute`, not
`ComplexExecutor`, and the result's `execution_links` row has
`engine='workflow'`.
