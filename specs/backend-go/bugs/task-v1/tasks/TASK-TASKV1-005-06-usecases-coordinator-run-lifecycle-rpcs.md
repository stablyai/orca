# TASK-TASKV1-005-06: Usecases — `StartCoordinatorRun`, `GetCoordinatorRun`, `CompleteCoordinatorRun`, `FailCoordinatorRun`, `RecordHeartbeat`, `ListPendingDecisionGates`

**From Solution:** SOL-TASKV1-005
**Priority:** P1
**Service:** `orchestration-service` (`internal/usecase`)
**File:** `backend-go/services/orchestration-service/internal/usecase/start_coordinator_run.go`, `get_coordinator_run.go`, `complete_coordinator_run.go`, `fail_coordinator_run.go`, `record_heartbeat.go`, `list_pending_decision_gates.go` (all new)
**Depends on:** TASK-TASKV1-005-04 (ports), TASK-TASKV1-005-05 (postgres implementation, needed for tests to run against something real — the usecase code itself only needs the interface)
**Status:** `[ ]` TODO

---

## Context

None of these usecases exist today — grep confirms zero matches for
`StartCoordinatorRun`/`GetCoordinatorRun`/`CompleteCoordinatorRun`/
`FailCoordinatorRun`/`RecordHeartbeat`/`ListPendingDecisionGates` anywhere
under `internal/usecase`. Each follows the exact shape
`update_task_status_and_promote.go` and `create_dispatch_context.go`
already establish: `tenant.RequireTenantID` → input validation →
(`serializer.Do` when the port needs handle-keyed serialization) → repo
call → `apperrors` mapping.

## Changes to make

Create `backend-go/services/orchestration-service/internal/usecase/start_coordinator_run.go`:

```go
package usecase

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/google/uuid"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/common/tenant"

	"github.com/stablyai/orca-go/services/orchestration-service/internal/domain"
)

// StartCoordinatorRunInput mirrors the StartCoordinatorRunRequest RPC message.
type StartCoordinatorRunInput struct {
	OriginTaskID string
	SpecJSON     json.RawMessage
	WorktreeID   string
}

// StartCoordinatorRun is orchestration-service's entry point into the
// complex execution path (orchestration-service.md §2.2/§3): validates and
// persists a new running CoordinatorRun plus its expanded OrchestrationTask
// DAG, then returns immediately — the tick loop (TASK-TASKV1-005-10)
// autonomously advances it from there.
type StartCoordinatorRun struct {
	repo       CoordinatorRunRepository
	serializer HandleSerializer
}

func NewStartCoordinatorRun(repo CoordinatorRunRepository, serializer HandleSerializer) *StartCoordinatorRun {
	return &StartCoordinatorRun{repo: repo, serializer: serializer}
}

func (uc *StartCoordinatorRun) Execute(ctx context.Context, in StartCoordinatorRunInput) (domain.CoordinatorRun, error) {
	tenantID, err := tenant.RequireTenantID(ctx)
	if err != nil {
		return domain.CoordinatorRun{}, apperrors.New(apperrors.KindUnauthenticated, "ORCH_NO_TENANT", "no tenant in request context", err)
	}
	if in.OriginTaskID == "" {
		return domain.CoordinatorRun{}, apperrors.New(apperrors.KindInvalidArgument, "ORCH_EMPTY_ORIGIN_TASK_ID", "origin_task_id is required", nil)
	}

	// coordinatorHandle is this run's own mailbox identity; format matches
	// assignee_handle's informal "kind:id" convention elsewhere in this service.
	coordinatorHandle := "coordinator:" + uuid.NewString()
	run, err := domain.NewCoordinatorRun("", tenantID, in.OriginTaskID, coordinatorHandle, in.SpecJSON, 0)
	if err != nil {
		return domain.CoordinatorRun{}, apperrors.New(apperrors.KindInvalidArgument, "ORCH_INVALID_RUN", "invalid coordinator run", err)
	}
	run.Status = domain.RunStatusRunning // NewCoordinatorRun defaults to Idle; StartCoordinatorRun's whole point is starting it immediately
	run.WorktreeID = in.WorktreeID

	// Validate spec_json shape up front (fail fast, clear error, no
	// partial DB write) via a throwaway ExpandSpec call — the repository
	// re-runs ExpandSpec itself inside its own transaction with the real
	// minted run id (see TASK-TASKV1-005-05's CreateWithTasks), so this
	// call's only job is rejecting a malformed spec before touching the DB.
	if _, err := domain.ExpandSpec(tenantID, "placeholder", in.OriginTaskID, in.SpecJSON); err != nil {
		return domain.CoordinatorRun{}, mapExpandSpecErr(err)
	}

	var out domain.CoordinatorRun
	err = uc.serializer.Do(ctx, in.OriginTaskID, func() error {
		created, err := uc.repo.CreateWithTasks(ctx, tenantID, run)
		if err != nil {
			return err
		}
		out = created
		return nil
	})
	if err != nil {
		return domain.CoordinatorRun{}, apperrors.New(apperrors.KindInternal, "ORCH_START_COORDINATOR_RUN_FAILED", "failed to start coordinator run", err)
	}
	return out, nil
}

// mapExpandSpecErr maps domain.ExpandSpec's sentinel errors to
// KindInvalidArgument — a malformed spec_json is always the caller's
// fault, never an internal failure.
func mapExpandSpecErr(err error) error {
	switch {
	case errors.Is(err, domain.ErrEmptySpec):
		return apperrors.New(apperrors.KindInvalidArgument, "ORCH_EMPTY_SPEC", "spec_json must contain at least one node", err)
	case errors.Is(err, domain.ErrDuplicateTempID):
		return apperrors.New(apperrors.KindInvalidArgument, "ORCH_DUPLICATE_TEMP_ID", "spec_json has a duplicate tempId", err)
	case errors.Is(err, domain.ErrDanglingDep):
		return apperrors.New(apperrors.KindInvalidArgument, "ORCH_DANGLING_DEP", "spec_json has a dep referencing an unknown tempId", err)
	default:
		return apperrors.New(apperrors.KindInvalidArgument, "ORCH_INVALID_SPEC", "spec_json is invalid", err)
	}
}
```

Create `backend-go/services/orchestration-service/internal/usecase/get_coordinator_run.go`:

```go
package usecase

import (
	"context"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/common/tenant"

	"github.com/stablyai/orca-go/services/orchestration-service/internal/domain"
)

// GetCoordinatorRun is a plain point-in-time read — mirrors
// GetDispatchContextForTask's shape (no serializer needed for a read).
type GetCoordinatorRun struct {
	repo CoordinatorRunRepository
}

func NewGetCoordinatorRun(repo CoordinatorRunRepository) *GetCoordinatorRun {
	return &GetCoordinatorRun{repo: repo}
}

func (uc *GetCoordinatorRun) Execute(ctx context.Context, id string) (domain.CoordinatorRun, error) {
	tenantID, err := tenant.RequireTenantID(ctx)
	if err != nil {
		return domain.CoordinatorRun{}, apperrors.New(apperrors.KindUnauthenticated, "ORCH_NO_TENANT", "no tenant in request context", err)
	}
	if id == "" {
		return domain.CoordinatorRun{}, apperrors.New(apperrors.KindInvalidArgument, "ORCH_EMPTY_RUN_ID", "id is required", nil)
	}
	run, err := uc.repo.Get(ctx, tenantID, id)
	if err != nil {
		if err == ErrRunNotFound {
			return domain.CoordinatorRun{}, apperrors.New(apperrors.KindNotFound, "ORCH_RUN_NOT_FOUND", "coordinator run not found", err)
		}
		return domain.CoordinatorRun{}, apperrors.New(apperrors.KindInternal, "ORCH_GET_COORDINATOR_RUN_FAILED", "failed to get coordinator run", err)
	}
	return run, nil
}
```

Create `backend-go/services/orchestration-service/internal/usecase/complete_coordinator_run.go`
and `fail_coordinator_run.go` — both follow
`update_task_status_and_promote.go`'s exact shape (tenant check → empty-id
check → `serializer.Do` keyed by run id → repo call → `apperrors` mapping);
the only domain-specific line in each is the repo call:

```go
// complete_coordinator_run.go
package usecase

import (
	"context"
	"encoding/json"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/common/tenant"

	"github.com/stablyai/orca-go/services/orchestration-service/internal/domain"
)

type CompleteCoordinatorRunInput struct {
	ID         string
	ResultJSON json.RawMessage
}

// CompleteCoordinatorRun is exposed as a caller-invokable usecase (not
// only an internal transition) so an operator/admin path can force-finalize
// a run — orchestration-service.md §3 lists it as part of the RPC surface.
// It is ALSO called internally by UpdateTaskStatusAndPromote's
// run-completion tail (TASK-TASKV1-005-07) via the same repo method, not
// by re-invoking this usecase (that path already holds tenantID and needs
// no re-authentication).
type CompleteCoordinatorRun struct {
	repo       CoordinatorRunRepository
	serializer HandleSerializer
}

func NewCompleteCoordinatorRun(repo CoordinatorRunRepository, serializer HandleSerializer) *CompleteCoordinatorRun {
	return &CompleteCoordinatorRun{repo: repo, serializer: serializer}
}

func (uc *CompleteCoordinatorRun) Execute(ctx context.Context, in CompleteCoordinatorRunInput) (domain.CoordinatorRun, error) {
	tenantID, err := tenant.RequireTenantID(ctx)
	if err != nil {
		return domain.CoordinatorRun{}, apperrors.New(apperrors.KindUnauthenticated, "ORCH_NO_TENANT", "no tenant in request context", err)
	}
	if in.ID == "" {
		return domain.CoordinatorRun{}, apperrors.New(apperrors.KindInvalidArgument, "ORCH_EMPTY_RUN_ID", "id is required", nil)
	}
	var out domain.CoordinatorRun
	err = uc.serializer.Do(ctx, in.ID, func() error {
		completed, err := uc.repo.Complete(ctx, tenantID, in.ID, in.ResultJSON)
		if err != nil {
			return err
		}
		out = completed
		return nil
	})
	if err != nil {
		if err == ErrRunNotFound {
			return domain.CoordinatorRun{}, apperrors.New(apperrors.KindNotFound, "ORCH_RUN_NOT_FOUND", "coordinator run not found", err)
		}
		return domain.CoordinatorRun{}, apperrors.New(apperrors.KindInternal, "ORCH_COMPLETE_COORDINATOR_RUN_FAILED", "failed to complete coordinator run", err)
	}
	return out, nil
}
```

```go
// fail_coordinator_run.go — identical shape, repo.Fail(ctx, tenantID, in.ID, in.ErrorMessage) instead of Complete
package usecase

import (
	"context"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/common/tenant"

	"github.com/stablyai/orca-go/services/orchestration-service/internal/domain"
)

type FailCoordinatorRunInput struct {
	ID           string
	ErrorMessage string
}

type FailCoordinatorRun struct {
	repo       CoordinatorRunRepository
	serializer HandleSerializer
}

func NewFailCoordinatorRun(repo CoordinatorRunRepository, serializer HandleSerializer) *FailCoordinatorRun {
	return &FailCoordinatorRun{repo: repo, serializer: serializer}
}

func (uc *FailCoordinatorRun) Execute(ctx context.Context, in FailCoordinatorRunInput) (domain.CoordinatorRun, error) {
	tenantID, err := tenant.RequireTenantID(ctx)
	if err != nil {
		return domain.CoordinatorRun{}, apperrors.New(apperrors.KindUnauthenticated, "ORCH_NO_TENANT", "no tenant in request context", err)
	}
	if in.ID == "" {
		return domain.CoordinatorRun{}, apperrors.New(apperrors.KindInvalidArgument, "ORCH_EMPTY_RUN_ID", "id is required", nil)
	}
	var out domain.CoordinatorRun
	err = uc.serializer.Do(ctx, in.ID, func() error {
		failed, err := uc.repo.Fail(ctx, tenantID, in.ID, in.ErrorMessage)
		if err != nil {
			return err
		}
		out = failed
		return nil
	})
	if err != nil {
		if err == ErrRunNotFound {
			return domain.CoordinatorRun{}, apperrors.New(apperrors.KindNotFound, "ORCH_RUN_NOT_FOUND", "coordinator run not found", err)
		}
		return domain.CoordinatorRun{}, apperrors.New(apperrors.KindInternal, "ORCH_FAIL_COORDINATOR_RUN_FAILED", "failed to fail coordinator run", err)
	}
	return out, nil
}
```

Create `backend-go/services/orchestration-service/internal/usecase/record_heartbeat.go`:

```go
package usecase

import (
	"context"
	"errors"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/common/tenant"

	"github.com/stablyai/orca-go/services/orchestration-service/internal/domain"
)

// RecordHeartbeat mirrors §8's "no cross-service calls, p99 < 30ms"
// budget: no serializer, no transaction, single UPDATE.
type RecordHeartbeat struct {
	repo DispatchContextRepository
}

func NewRecordHeartbeat(repo DispatchContextRepository) *RecordHeartbeat {
	return &RecordHeartbeat{repo: repo}
}

func (uc *RecordHeartbeat) Execute(ctx context.Context, dispatchContextID string) (domain.DispatchContext, error) {
	tenantID, err := tenant.RequireTenantID(ctx)
	if err != nil {
		return domain.DispatchContext{}, apperrors.New(apperrors.KindUnauthenticated, "ORCH_NO_TENANT", "no tenant in request context", err)
	}
	if dispatchContextID == "" {
		return domain.DispatchContext{}, apperrors.New(apperrors.KindInvalidArgument, "ORCH_EMPTY_DISPATCH_CONTEXT_ID", "dispatch_context_id is required", nil)
	}
	dc, err := uc.repo.RecordHeartbeat(ctx, tenantID, dispatchContextID)
	if err != nil {
		if errors.Is(err, ErrDispatchContextNotFound) {
			return domain.DispatchContext{}, apperrors.New(apperrors.KindNotFound, "ORCH_DISPATCH_CONTEXT_NOT_FOUND", "dispatch context not found", err)
		}
		return domain.DispatchContext{}, apperrors.New(apperrors.KindInternal, "ORCH_RECORD_HEARTBEAT_FAILED", "failed to record heartbeat", err)
	}
	return dc, nil
}
```

Create `backend-go/services/orchestration-service/internal/usecase/list_pending_decision_gates.go`:

```go
package usecase

import (
	"context"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/common/tenant"

	"github.com/stablyai/orca-go/services/orchestration-service/internal/domain"
)

// ListPendingDecisionGates is read-only, mirrors
// ListActiveDispatchContextsForUser's shape exactly (tenant from identity,
// no other input).
type ListPendingDecisionGates struct {
	repo GateRepository
}

func NewListPendingDecisionGates(repo GateRepository) *ListPendingDecisionGates {
	return &ListPendingDecisionGates{repo: repo}
}

func (uc *ListPendingDecisionGates) Execute(ctx context.Context) ([]domain.DecisionGate, error) {
	tenantID, err := tenant.RequireTenantID(ctx)
	if err != nil {
		return nil, apperrors.New(apperrors.KindUnauthenticated, "ORCH_NO_TENANT", "no tenant in request context", err)
	}
	gates, err := uc.repo.ListPending(ctx, tenantID)
	if err != nil {
		return nil, apperrors.New(apperrors.KindInternal, "ORCH_LIST_PENDING_GATES_FAILED", "failed to list pending decision gates", err)
	}
	return gates, nil
}
```

## Verify

```bash
cd /opt/repos/orca/backend-go
go build ./services/orchestration-service/...
go test ./services/orchestration-service/internal/usecase/... -run 'TestStartCoordinatorRun|TestGetCoordinatorRun|TestCompleteCoordinatorRun|TestFailCoordinatorRun|TestRecordHeartbeat|TestListPendingDecisionGates' -v
```

Write fakes for `CoordinatorRunRepository`/`DispatchContextRepository`/
`GateRepository` (same in-memory-map style the existing
`update_task_status_and_promote_test.go` fake uses) covering:
- `StartCoordinatorRun`: happy path returns a `RunStatusRunning` run;
  invalid `spec_json` returns `KindInvalidArgument` (`ORCH_EMPTY_SPEC`/
  `ORCH_DUPLICATE_TEMP_ID`/`ORCH_DANGLING_DEP` per the malformed case)
  WITHOUT calling `CreateWithTasks` at all (fail fast); missing tenant →
  `KindUnauthenticated`; empty `origin_task_id` → `KindInvalidArgument`.
- `GetCoordinatorRun`/`CompleteCoordinatorRun`/`FailCoordinatorRun`: happy
  path, not-found → `KindNotFound`, empty-id validation.
- `RecordHeartbeat`: happy path updates `LastHeartbeatAt`; not-found path.
- `ListPendingDecisionGates`: returns only `GateStatusPending` rows for the
  caller's tenant (fake repo pre-seeded with a mix of pending/resolved
  gates across two tenants).
