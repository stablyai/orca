package usecase

import (
	"context"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/common/tenant"
	"github.com/stablyai/orca-go/services/task-service/internal/domain"
)

// UpdateTaskInput mirrors the UpdateTask RPC request's wrapper-typed
// optional fields — a status-only edit shouldn't require resending Title.
// See CreateTaskInput's doc comment for why TenantID isn't a field here.
type UpdateTaskInput struct {
	ID     string
	Title  *string
	Status *string
	// WorkflowTemplateID: nil = leave untouched, non-nil = set (an empty
	// string clears the attachment) — same wrapper-typed field-mask
	// convention as Title/Status. See docs/backlog/BACKLOG-016.
	WorkflowTemplateID *string
}

// UpdateTask is task-service's one client-facing status-edit RPC. It
// deliberately does NOT become the general mechanism that clears
// StatusInProgress back out (the one-way-transition gap execute_task.go's
// doc comment names) — domain.Task.SetStatus rejects any transition into
// in_progress here, so a buggy or malicious client can't mark a
// still-running task done early or fake a dispatch it never made. See
// TASK-223's Context note.
type UpdateTask struct {
	repo TaskRepository
}

func NewUpdateTask(repo TaskRepository) *UpdateTask {
	return &UpdateTask{repo: repo}
}

func (uc *UpdateTask) Execute(ctx context.Context, in UpdateTaskInput) (domain.Task, error) {
	tenantID, err := tenant.RequireTenantID(ctx)
	if err != nil {
		return domain.Task{}, apperrors.New(apperrors.KindUnauthenticated, "TASK_NO_TENANT", "no tenant in request context", err)
	}
	if in.ID == "" {
		return domain.Task{}, apperrors.New(apperrors.KindInvalidArgument, "TASK_MISSING_ID", "id is required", nil)
	}

	current, err := uc.repo.Get(ctx, tenantID, in.ID)
	if err != nil {
		return domain.Task{}, apperrors.New(apperrors.KindNotFound, "TASK_NOT_FOUND", "task not found", err)
	}
	if in.Title != nil {
		current.Title = *in.Title
	}
	if in.Status != nil {
		updated, err := current.SetStatus(*in.Status)
		if err != nil {
			return domain.Task{}, apperrors.New(apperrors.KindInvalidArgument, "TASK_INVALID_STATUS_TRANSITION", err.Error(), err)
		}
		current = updated
	}
	if in.WorkflowTemplateID != nil {
		current.WorkflowTemplateID = *in.WorkflowTemplateID
	}
	if err := uc.repo.Update(ctx, tenantID, current); err != nil {
		return domain.Task{}, apperrors.New(apperrors.KindInternal, "TASK_UPDATE_FAILED", "failed to persist update", err)
	}
	return current, nil
}
