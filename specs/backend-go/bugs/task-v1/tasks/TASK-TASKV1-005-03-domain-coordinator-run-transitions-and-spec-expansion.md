# TASK-TASKV1-005-03: Domain — `CoordinatorRun.Complete`/`Fail` transitions + new `ExpandSpec` DAG-materialization

**From Solution:** SOL-TASKV1-005
**Priority:** P1
**Service:** `orchestration-service` (domain layer — zero imports outside stdlib + other domain packages, per `03-clean-architecture-guidelines.md`)
**File:** `backend-go/services/orchestration-service/internal/domain/orchestration.go` (extend), `backend-go/services/orchestration-service/internal/domain/spec.go` (new)
**Depends on:** none (pure domain code, no dependency on proto/migration landing first)
**Status:** `[ ]` TODO

---

## Context

`domain.CoordinatorRun` (`internal/domain/orchestration.go:306-340`,
confirmed by reading the file) is already a complete value type with
`NewCoordinatorRun` — `Status`, `CoordinatorHandle`, `PollIntervalMs` all
already modeled, defaulting to `RunStatusIdle`. It has no transition
methods at all today. This task adds `Complete`/`Fail`, mirroring
`DecisionGate.Resolve`'s existing one-way-door discipline
(`orchestration.go:275-282`): `ErrGateAlreadyResolved` guards against
resolving a gate twice, and this task's `ErrRunNotRunning` guards the same
class of bug for a run.

Separately, `StartCoordinatorRunRequest.spec_json` (added in
`TASK-TASKV1-005-02`) is an opaque payload from `task-service`. Nothing in
this codebase today turns that payload into `OrchestrationTask` rows — this
is the gap `orchestration-service.md` §3/§8 explicitly leave for an
implementer to design. `domain.ExpandSpec` (new file `spec.go`) is that
pure, unit-testable function.

## Changes to make

In `backend-go/services/orchestration-service/internal/domain/orchestration.go`,
add after the existing `NewCoordinatorRun` function (end of file, after
line 340):

```go
// ErrRunNotRunning guards CoordinatorRun.Complete/Fail's one-way-door
// invariant — mirrors ErrGateAlreadyResolved's role for DecisionGate.Resolve.
var ErrRunNotRunning = errors.New("domain: coordinator run is not running")

// Complete transitions a running CoordinatorRun to completed. A run cannot
// be completed twice, closing the same double-transition class of bug
// ErrGateAlreadyResolved guards against for DecisionGate.
func (r CoordinatorRun) Complete(result json.RawMessage) (CoordinatorRun, error) {
	if r.Status != RunStatusRunning {
		return CoordinatorRun{}, ErrRunNotRunning
	}
	r.Status = RunStatusCompleted
	r.Result = result
	return r, nil
}

// Fail transitions a running CoordinatorRun to failed. A run may be failed
// from RunStatusRunning OR RunStatusIdle (e.g. StartCoordinatorRun's own
// spec-expansion step failing before any task ever ran) — unlike Complete,
// which only makes sense once work has actually started.
func (r CoordinatorRun) Fail(errMsg string) (CoordinatorRun, error) {
	if r.Status != RunStatusRunning && r.Status != RunStatusIdle {
		return CoordinatorRun{}, ErrRunNotRunning
	}
	r.Status = RunStatusFailed
	r.ErrorMessage = errMsg
	return r, nil
}
```

`CoordinatorRun` (struct at `orchestration.go:308-318`) needs two new
fields for `Complete`/`Fail` to write into and for the repository layer
(`TASK-TASKV1-005-05`) to persist — add to the struct:

```go
type CoordinatorRun struct {
	ID                string
	TenantID          string
	OriginTaskID      string
	Spec              json.RawMessage
	Status            RunStatus
	CoordinatorHandle string
	PollIntervalMs    int32
	WorktreeID        string          // caller-supplied, optional — see StartCoordinatorRunRequest.worktree_id
	Result            json.RawMessage // set by Complete
	ErrorMessage      string          // set by Fail
	ReportedAt        time.Time       // zero until TaskServiceReporter.ReportResult succeeds (TASK-TASKV1-005-07)
	CreatedAt         time.Time
	CompletedAt       time.Time
}
```

Create `backend-go/services/orchestration-service/internal/domain/spec.go`:

```go
// Package domain — spec.go: pure DAG-node materialization for
// StartCoordinatorRun's spec_json payload. Kept in its own file since
// orchestration.go's existing doc comment scopes that file to the entity
// definitions themselves, not caller-driven expansion logic.
package domain

import (
	"encoding/json"
	"errors"
	"fmt"
)

// SpecNode is the caller-supplied shape StartCoordinatorRunRequest.spec_json
// must parse into — the CLOSED contract between task-service's
// buildOrchestrationSpec (SOL-TG-04) and this service's ExpandSpec. Kept
// deliberately minimal: task-service's own richer per-task fields
// (prompt_template, description) travel inside Spec (opaque JSONB on the
// resulting OrchestrationTask), not as SpecNode fields — this service
// never interprets task-service's authoring content, per
// orchestration-service.md's "does not decide decomposition strategy."
type SpecNode struct {
	TempID string          `json:"tempId"`
	Title  string          `json:"title"`
	Spec   json.RawMessage `json:"spec"`
	Deps   []string        `json:"deps"` // TempIDs of sibling nodes, same closed set
}

// ErrEmptySpec / ErrDuplicateTempID / ErrDanglingDep guard ExpandSpec's
// invariants — a malformed spec must fail StartCoordinatorRun closed
// rather than create a DAG that can never promote (a dangling dep
// reference for a node that also has status pending would sit stuck
// forever, silently, which is worse than a rejected request).
var (
	ErrEmptySpec       = errors.New("domain: spec must contain at least one node")
	ErrDuplicateTempID = errors.New("domain: duplicate tempId in spec")
	ErrDanglingDep     = errors.New("domain: dep references an unknown tempId")
)

// ExpandSpec parses spec_json into SpecNodes and materializes them into
// OrchestrationTasks scoped to coordinatorRunID/tenantID — real IDs are NOT
// minted here (the repository mints them on INSERT, matching
// OrchestrationTaskRepository.Create's existing id-if-empty convention,
// repository.go:44-46); this function instead resolves each node's Deps
// from TempID strings so the repository layer (TASK-TASKV1-005-05) can
// resolve them to real minted ids inside its own INSERT transaction. Root
// node (index 0 in the returned slice) is fixed as nodes[0] by convention
// — task-service's buildOrchestrationSpec always emits the root task
// first (SOL-TG-04's own sketch: "origin_task_id = rootTaskID").
func ExpandSpec(tenantID, coordinatorRunID, originTaskID string, specJSON json.RawMessage) ([]OrchestrationTask, error) {
	var nodes []SpecNode
	if err := json.Unmarshal(specJSON, &nodes); err != nil {
		return nil, fmt.Errorf("domain: invalid spec_json: %w", err)
	}
	if len(nodes) == 0 {
		return nil, ErrEmptySpec
	}
	seen := make(map[string]struct{}, len(nodes))
	for _, n := range nodes {
		if _, dup := seen[n.TempID]; dup {
			return nil, ErrDuplicateTempID
		}
		seen[n.TempID] = struct{}{}
	}
	tasks := make([]OrchestrationTask, 0, len(nodes))
	for i, n := range nodes {
		for _, d := range n.Deps {
			if _, ok := seen[d]; !ok {
				return nil, ErrDanglingDep
			}
		}
		origin := ""
		if i == 0 {
			origin = originTaskID // root row only, per §4's field doc comment
		}
		status := TaskStatusPending
		if len(n.Deps) == 0 {
			status = TaskStatusReady // no deps -> immediately dispatchable, matches DepsSatisfied(nil) == true
		}
		tasks = append(tasks, OrchestrationTask{
			TenantID:         tenantID,
			CoordinatorRunID: coordinatorRunID,
			OriginTaskID:     origin,
			TaskTitle:        n.Title,
			Spec:             n.Spec,
			Status:           status,
			Deps:             n.Deps, // still TempIDs here; repository.CreateWithTasks resolves TempID->real id in the same transaction
		})
	}
	return tasks, nil
}
```

Note: `ExpandSpec` sets `TaskTitle: n.Title` but `SpecNode` has no
requirement that `Title` be non-empty — `NewOrchestrationTask`'s
`ErrEmptyTaskTitle` check is bypassed here because `ExpandSpec` builds
`OrchestrationTask` struct literals directly, not via the constructor (the
repository's `Create`/`CreateWithTasks` path does not currently call
`NewOrchestrationTask` either — confirmed by reading
`repository.go:44-71`). This is consistent with existing behavior, not a
new gap introduced by this task.

## Verify

```bash
cd /opt/repos/orca/backend-go
go build ./services/orchestration-service/...
go test ./services/orchestration-service/internal/domain/... -run 'TestCoordinatorRun_Complete|TestCoordinatorRun_Fail|TestExpandSpec' -v
```

Write `internal/domain/orchestration_test.go` additions and new
`internal/domain/spec_test.go` covering:
- `Complete`: valid from `running`; rejects `idle`/`completed`/`failed` with `ErrRunNotRunning`.
- `Fail`: valid from `running` AND `idle`; rejects `completed`/`failed` with `ErrRunNotRunning`.
- `ExpandSpec`: single-node spec with no deps → one task, `TaskStatusReady`; multi-node spec with a dep chain → only the no-dep node(s) start `ready`, the rest `pending`; duplicate `tempId` → `ErrDuplicateTempID`; a `deps` entry naming an unknown `tempId` → `ErrDanglingDep`; empty node array → `ErrEmptySpec`; malformed JSON → wrapped error, not a panic; root node (`nodes[0]`) gets `OriginTaskID` set, every other node's `OriginTaskID` is empty.
