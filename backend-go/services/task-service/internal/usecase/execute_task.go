package usecase

import (
	"context"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/common/tenant"
	"github.com/stablyai/orca-go/services/task-service/internal/domain"
)

type ExecuteTaskInput struct {
	TaskID    string
	RequestID string
	// Prompt overrides the executor's own default prompt (built from the
	// task's Title) when non-empty — see docs/backlog/BACKLOG-016 and
	// SimpleExecutor.buildExecutePrompt's doc comment for the default it
	// replaces. Not persisted onto the task.
	Prompt string
}

// ExecuteTask is task-service's execution-dispatch usecase (§3.1). The
// branching logic — simple vs. complex — is this usecase's real,
// non-stubbed value: a task with any parent_child (subtask) or depends_on
// edge FROM it is "complex" and hands off to ComplexExecutor
// (orchestration-service); otherwise it's "simple" and relays directly to
// SimpleExecutor (infra-fleet-service). Both executors are STUBS in this
// scaffold (internal/adapter/grpcclient) — only the branch decision itself
// is real.
//
// Execute also marks the task StatusInProgress (via TaskRepository) before
// dispatching — a real, persisted state transition added for Epic C
// (backend-go/docs/execution-plan.md) so usecase.HasActiveExecutions has
// something true to query. This is honestly one-way in this scaffold:
// task-service has no execution-completion callback at all, so nothing ever
// transitions a task back out of in_progress today (there is no
// UpdateTask/SetStatus RPC in the generated proto). HasActiveExecutions will
// therefore over-report "active" for any task ever dispatched here, until a
// real completion/update-status path is built — see this service's README
// "Known gaps" for that follow-up. Because the status update is the entire
// point of this addition, a failure to persist it fails the whole Execute
// call rather than silently proceeding with dispatch but no recorded state.
type ExecuteTask struct {
	repo    TaskRepository
	edges   EdgeRepository
	simple  SimpleExecutor
	complex ComplexExecutor
}

func NewExecuteTask(repo TaskRepository, edges EdgeRepository, simple SimpleExecutor, complex ComplexExecutor) *ExecuteTask {
	return &ExecuteTask{repo: repo, edges: edges, simple: simple, complex: complex}
}

func (uc *ExecuteTask) Execute(ctx context.Context, in ExecuteTaskInput) (string, error) {
	tenantID, err := tenant.RequireTenantID(ctx)
	if err != nil {
		return "", apperrors.New(apperrors.KindUnauthenticated, "TASK_NO_TENANT", "no tenant in request context", err)
	}
	if in.TaskID == "" {
		return "", apperrors.New(apperrors.KindInvalidArgument, "TASK_EXECUTE_INVALID", "task_id is required", nil)
	}

	if err := uc.repo.UpdateStatus(ctx, tenantID, in.TaskID, domain.StatusInProgress); err != nil {
		return "", apperrors.New(apperrors.KindInternal, "TASK_EXECUTE_STATUS_UPDATE_FAILED", "failed to mark task in_progress", err)
	}

	complex, err := uc.isComplex(ctx, tenantID, in.TaskID)
	if err != nil {
		return "", apperrors.New(apperrors.KindInternal, "TASK_EXECUTE_EDGE_LOOKUP_FAILED", "failed to determine task complexity", err)
	}

	var ref string
	if complex {
		ref, err = uc.complex.Execute(ctx, tenantID, in.TaskID, in.RequestID, in.Prompt)
	} else {
		ref, err = uc.simple.Execute(ctx, tenantID, in.TaskID, in.RequestID, in.Prompt)
	}
	if err != nil {
		return "", apperrors.New(apperrors.KindInternal, "TASK_EXECUTE_FAILED", "execution dispatch failed", err)
	}
	return ref, nil
}

// isComplex implements task-service.md §3.1's branch: "a complex task has
// subtasks and/or dependency edges."
func (uc *ExecuteTask) isComplex(ctx context.Context, tenantID, taskID string) (bool, error) {
	children, err := uc.edges.ListFrom(ctx, tenantID, taskID, domain.EdgeKindParentChild)
	if err != nil {
		return false, err
	}
	if len(children) > 0 {
		return true, nil
	}

	deps, err := uc.edges.ListFrom(ctx, tenantID, taskID, domain.EdgeKindDependsOn)
	if err != nil {
		return false, err
	}
	return len(deps) > 0, nil
}
