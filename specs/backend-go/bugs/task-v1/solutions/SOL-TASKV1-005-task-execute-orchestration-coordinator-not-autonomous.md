# SOL-TASKV1-005: `StartCoordinatorRun` + 5 missing RPCs, and a real autonomous dispatch-tick loop for `orchestration-service`

**Resolves:** [BUG-TASKV1-005](../BUG-TASKV1-005-task-execute-orchestration-coordinator-not-autonomous.md)
**Service:** `orchestration-service` (primary — proto, domain, usecase, postgres, `cmd/server/main.go`) + `infra-fleet-service` (client, worker dispatch, reuses the existing `InfraFleetServiceClient` relay pattern `task-service.SimpleExecutor` already uses) + `task-service` (client, terminal-state callback — the request/response shape is [SOL-TG-04](../../logic-v1/solutions/SOL-TG-04-task-agent-execution.md)'s already-designed `ReportTaskExecutionResult`, not redesigned here)
**Affected files (proposed):**
- `backend-go/proto/orca/orchestration/v1/orchestration.proto` (6 new RPCs: `StartCoordinatorRun`, `GetCoordinatorRun`, `CompleteCoordinatorRun`, `FailCoordinatorRun`, `RecordHeartbeat`, `ListPendingDecisionGates`)
- `backend-go/services/orchestration-service/internal/domain/orchestration.go` (`CoordinatorRun.Complete()`/`Fail()` transitions; `OrchestrationTask.Result`/spec-expansion helper)
- `backend-go/services/orchestration-service/internal/domain/spec.go` (new — pure `ExpandSpec(spec) ([]OrchestrationTask, error)`, the DAG-node materialization the TS coordinator did inline)
- `backend-go/services/orchestration-service/internal/usecase/ports.go` (extend `OrchestrationTaskRepository`, `DispatchContextRepository`, `GateRepository`; new `CoordinatorRunRepository`, `WorkerDispatcher`, `TaskServiceReporter` ports)
- `backend-go/services/orchestration-service/internal/usecase/start_coordinator_run.go`, `get_coordinator_run.go`, `complete_coordinator_run.go`, `fail_coordinator_run.go`, `record_heartbeat.go`, `list_pending_decision_gates.go` (new)
- `backend-go/services/orchestration-service/internal/usecase/update_task_status_and_promote.go` (extend: after promotion, check run-completion in the SAME transaction)
- `backend-go/services/orchestration-service/internal/usecase/tick_dispatch.go` (new — the autonomous loop's one usecase call per tick)
- `backend-go/services/orchestration-service/internal/adapter/postgres/repository.go` (new `CoordinatorRunRepository`/`OrchestrationTaskRepository` methods, `RecordHeartbeat`, `ListPending`)
- `backend-go/services/orchestration-service/internal/adapter/infrafleetclient/worker_dispatcher.go` (new)
- `backend-go/services/orchestration-service/internal/adapter/taskserviceclient/reporter.go` (new)
- `backend-go/services/orchestration-service/internal/adapter/grpc/server.go` (6 new handlers)
- `backend-go/services/orchestration-service/migrations/0004_coordinator_run_lifecycle.{up,down}.sql` (new)
- `backend-go/services/orchestration-service/cmd/server/main.go` (dial `infra-fleet-service`/`task-service`, start the tick-loop goroutine)
- Corresponding `_test.go` files for every new usecase, domain function, and repository method
**Status:** 📋 Proposed — not yet implemented (new finding, no prior design exists anywhere for this bug)

---

## Design rationale (grounded in TDD + real code)

`orchestration-service.md` §3's API sketch (lines 74-98) is the source of
truth this solution builds against — it names exactly the 11 RPCs
BUG-TASKV1-005 audits, of which 6 are missing:
`StartCoordinatorRun`/`GetCoordinatorRun`/`CompleteCoordinatorRun`/
`FailCoordinatorRun`/`RecordHeartbeat`/`ListPendingDecisionGates`. §2.2's
flowchart (lines 62-69) fixes the entry-point contract: `task-service`
calls `StartCoordinatorRun(taskId, spec)` and gets a run back
immediately — the run then progresses on its own. This solution's job is
making that "on its own" real, not merely adding 6 request/response RPCs
that still require a caller to drive every step (which would just move
BUG-TASKV1-005's finding from "5 RPCs missing" to "11 RPCs present but the
coordinator still isn't autonomous").

**What already exists and must not be redesigned** (confirmed by reading
the current code, not assumed):

- `domain.CoordinatorRun` (`internal/domain/orchestration.go:308-340`) is
  already a complete value type with `NewCoordinatorRun` — `Status`,
  `CoordinatorHandle`, `PollIntervalMs` all already modeled. This solution
  adds two small transition methods (`Complete`/`Fail`), it does not touch
  the existing constructor.
- `orchestration.coordinator_runs` (`migrations/0001_init.up.sql:8-22`) is
  already a real table with RLS — this solution's migration only adds the
  columns the lifecycle RPCs need that don't exist yet (`worktree_id`,
  `result`, `error_message`), following the exact additive-migration
  pattern `0002_dispatch_context_user_id.up.sql`/
  `0003_dispatch_context_worktree_id.up.sql` already established for this
  same service.
- `UpdateTaskStatusAndPromote` (`internal/usecase/update_task_status_and_promote.go:40-78`)
  is already the correct atomic promotion saga (§8) — this solution
  extends its transaction with one more step (check run-completion), it
  does not change the promotion logic itself.
- `HandleSerializer`/`*KeyedSerializer` (`internal/usecase/keyed_serializer.go`,
  wired once in `main.go:81`) is already real — reused as-is, keyed by
  `coordinator_run_id` for the new run-lifecycle usecases and by
  `orchestration_task_id` for per-task dispatch, following the exact
  keying discipline `ports.go:36-51`'s doc comments already establish for
  each existing repository.
- `usecase.ClassifyDispatchFailure`/`FailDispatch` (existing, real,
  tested) are reused unmodified — the tick loop's dispatch-failure path
  calls the existing `FailDispatch` usecase rather than duplicating its
  circuit-breaker logic.

**What §3/§8 leave for an implementer to design, and this solution
specifies concretely**: how a `spec` (opaque JSONB from `task-service`,
per `orchestration-service.md §5`'s `coordinator_runs.spec JSONB NOT
NULL`) becomes a set of `orchestration_tasks` rows
(`ExpandSpec`, below); how "autonomously ticking the run's state machine"
(§2.2) is actually implemented as Go code (the tick loop, below); and how
a run's terminal state is detected and reported back to `task-service`
(the `UpdateTaskStatusAndPromote` extension + `TaskServiceReporter`,
below). None of this is contradicted by anything in §3-§10 — it fills in
exactly the gap those sections describe but do not code.

## Design — proto additions

```protobuf
// backend-go/proto/orca/orchestration/v1/orchestration.proto — additions

service OrchestrationService {
  // ... existing 7 RPCs unchanged ...

  rpc StartCoordinatorRun(StartCoordinatorRunRequest) returns (CoordinatorRun);
  rpc GetCoordinatorRun(GetCoordinatorRunRequest) returns (CoordinatorRun);
  rpc CompleteCoordinatorRun(CompleteCoordinatorRunRequest) returns (CoordinatorRun);
  rpc FailCoordinatorRun(FailCoordinatorRunRequest) returns (CoordinatorRun);
  rpc RecordHeartbeat(RecordHeartbeatRequest) returns (DispatchContext);
  rpc ListPendingDecisionGates(ListPendingDecisionGatesRequest) returns (ListPendingDecisionGatesResponse);
}

message CoordinatorRun {
  string id = 1;
  string origin_task_id = 2;      // logical FK -> task-service.Task.id, per §2.1
  string spec_json = 3;           // round-trips the caller-supplied spec verbatim
  string status = 4;              // idle|running|completed|failed
  string coordinator_handle = 5;
  int32 poll_interval_ms = 6;
  string worktree_id = 7;         // caller-supplied, same optional/nullable pattern as DispatchContext.worktree_id
  string result_json = 8;         // set when status=completed
  string error_message = 9;       // set when status=failed
}

// StartCoordinatorRunRequest.spec_json is an OPAQUE payload from
// task-service's ComplexExecutor (SOL-TG-04's buildOrchestrationSpec) —
// this service does not interpret task-service's shape, only the
// {tempId, title, description, deps: [tempId,...]}[] array ExpandSpec
// requires (see "Design — spec expansion" below), matching §2.1's
// "distinct id space... task-service.Task.ID rides along as each node's
// origin reference, not as the primary key here."
message StartCoordinatorRunRequest {
  string origin_task_id = 1;
  string spec_json = 2;
  string worktree_id = 3; // optional
}

message GetCoordinatorRunRequest { string id = 1; }

message CompleteCoordinatorRunRequest {
  string id = 1;
  string result_json = 2;
}

message FailCoordinatorRunRequest {
  string id = 1;
  string error_message = 2;
}

// RecordHeartbeat sits in the coordinator's tight poll loop (§8: "p99 <
// 30ms, no cross-service calls on that path") — reuses DispatchContext,
// no new message type needed, matching the existing GetDispatchContextForTaskResponse convention.
message RecordHeartbeatRequest { string dispatch_context_id = 1; }

message ListPendingDecisionGatesRequest {}  // tenant from identity, matches ListActiveDispatchContextsForUserRequest's pattern

message ListPendingDecisionGatesResponse {
  repeated DecisionGate gates = 1;
}
```

## Design — domain: `CoordinatorRun` transitions + spec expansion

```go
// internal/domain/orchestration.go — additive methods, existing struct/constructor untouched
var (
    ErrRunNotRunning = errors.New("domain: coordinator run is not running")
)

// Complete transitions a running CoordinatorRun to completed. Mirrors
// DecisionGate.Resolve's "one-way door" discipline (orchestration.go:275-282)
// — a run cannot be completed twice, closing the same double-transition
// class of bug ErrGateAlreadyResolved guards against.
func (r CoordinatorRun) Complete(result json.RawMessage) (CoordinatorRun, error) {
    if r.Status != RunStatusRunning {
        return CoordinatorRun{}, ErrRunNotRunning
    }
    r.Status = RunStatusCompleted
    return r, nil
}

// Fail transitions a running CoordinatorRun to failed. A run may be
// failed from RunStatusRunning OR RunStatusIdle (e.g. StartCoordinatorRun's
// own spec-expansion step failing before any task ever ran) — unlike
// Complete, which only makes sense once work has actually run.
func (r CoordinatorRun) Fail(errMsg string) (CoordinatorRun, error) {
    if r.Status != RunStatusRunning && r.Status != RunStatusIdle {
        return CoordinatorRun{}, ErrRunNotRunning
    }
    r.Status = RunStatusFailed
    return r, nil
}
```

```go
// internal/domain/spec.go (new)
package domain

import "encoding/json"

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
// from TempID strings to the OTHER nodes' (still-empty) positions so the
// repository layer can do a single batch insert following an id-generation
// pass. Root node (parentID == "" in the returned slice) is fixed as
// nodes[0] by convention — task-service's buildOrchestrationSpec always
// emits the root task first (SOL-TG-04's own sketch: "origin_task_id =
// rootTaskID").
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
            Deps:             n.Deps, // still TempIDs here; repository.CreateBatch resolves TempID->real id in the same transaction (see below)
        })
    }
    return tasks, nil
}
```

## Design — new ports (`ports.go` extensions)

```go
// CoordinatorRunRepository — new port, mirrors the existing repositories'
// naming/atomicity discipline (ports.go:36-124).
type CoordinatorRunRepository interface {
    // CreateWithTasks atomically inserts the coordinator_runs row (status
    // running) AND every OrchestrationTask from ExpandSpec, resolving each
    // task's Deps from SpecNode TempIDs to the freshly-minted real ids
    // WITHIN the same transaction — a torn write here would leave a run
    // with unresolvable deps, permanently stuck (same class of bug §8
    // guards UpdateStatusAndPromote against).
    CreateWithTasks(ctx context.Context, tenantID string, run domain.CoordinatorRun, tasks []domain.OrchestrationTask) (domain.CoordinatorRun, error)
    Get(ctx context.Context, tenantID, id string) (domain.CoordinatorRun, error)
    // Complete/Fail are single-row updates (no cross-table write), unlike
    // CreateWithTasks — simple, not wrapped in the txn helper.
    Complete(ctx context.Context, tenantID, id string, result json.RawMessage) (domain.CoordinatorRun, error)
    Fail(ctx context.Context, tenantID, id, errMsg string) (domain.CoordinatorRun, error)
    // ListRunning backs the tick loop's outer scan — every run this
    // instance should be advancing. Scoped by status only (not tenant):
    // the tick loop runs as the service's own internal identity, not a
    // per-request caller, so it must see every tenant's running runs.
    ListRunning(ctx context.Context) ([]domain.CoordinatorRun, error)
}

// WorkerDispatcher is the port the tick loop calls to actually hand a
// ready OrchestrationTask to a terminal-hosted AI-agent worker via
// infra-fleet-service -> Dev Server Agent — orchestration-service.md §7's
// "resolve connectionId for assignee_handle... sync gRPC per dispatch."
// This does not decide WHICH handle to assign (the tick loop does, see
// below) — it only performs the dispatch call for an already-chosen handle.
type WorkerDispatcher interface {
    Dispatch(ctx context.Context, tenantID string, task domain.OrchestrationTask, handle string) error
}

// TaskServiceReporter is the outbound port for reporting a coordinator
// run's terminal state back to task-service — the SERVER side of
// SOL-TG-04's ReportTaskExecutionResult RPC is task-service's, this is
// orchestration-service's client stub calling it.
type TaskServiceReporter interface {
    ReportResult(ctx context.Context, taskID, coordinatorRunID string, success bool, errMsg string) error
}
```

Extend the existing `OrchestrationTaskRepository`
(`ports.go:39-51`) with two read methods the tick loop and
`ListPendingDecisionGates`/run-completion check need:

```go
// ListReadyUnclaimed returns 'ready' tasks across ALL tenants/runs that
// have no dispatch_contexts row yet — the tick loop's outer scan. "Claim"
// (transition ready -> dispatched) happens per-task inside DispatchOne
// (below) via a CAS UPDATE, not here, so two concurrent tick instances
// listing the same task is safe: only one's claim UPDATE succeeds.
ListReadyUnclaimed(ctx context.Context) ([]domain.OrchestrationTask, error)

// CountNonTerminalByRun returns how many orchestration_tasks under
// coordinatorRunID are NOT in a terminal status (completed/failed) —
// UpdateTaskStatusAndPromote's extended transaction (below) uses this to
// decide "is this run done" without a second round-trip after COMMIT,
// which would reopen the exact torn-read race §8 exists to close.
CountNonTerminalByRun(ctx context.Context, tenantID, coordinatorRunID string) (int, error)

// ClaimReady atomically transitions ONE task from 'ready' to 'dispatched'
// (UPDATE ... WHERE status='ready' RETURNING, i.e. compare-and-swap) —
// returns (task, true, nil) on success, (zero, false, nil) if another
// tick instance already claimed it (not an error: expected under
// concurrent ticks, same "ok to lose the race" shape as
// sql.ErrNoRows-as-a-bool elsewhere in this codebase).
ClaimReady(ctx context.Context, tenantID, taskID string) (domain.OrchestrationTask, bool, error)
```

Extend `DispatchContextRepository` with:

```go
// RecordHeartbeat updates last_heartbeat_at = now() for dispatchContextID
// — a single-column UPDATE, no transaction needed (§8: "no cross-service
// calls on that path," p99 < 30ms budget rules out wrapping this in the
// heavier per-usecase txn+serializer pattern used elsewhere in this file).
RecordHeartbeat(ctx context.Context, tenantID, dispatchContextID string) (domain.DispatchContext, error)
```

Extend `GateRepository` with:

```go
// ListPending returns every pending decision_gates row for tenantID,
// backing ListPendingDecisionGates and reusing the existing
// idx_gates_pending partial index (0001_init.up.sql:91) — that index was
// created for exactly this query and has had zero callers until now.
ListPending(ctx context.Context, tenantID string) ([]domain.DecisionGate, error)
```

## Design — usecases

```go
// internal/usecase/start_coordinator_run.go
type StartCoordinatorRunInput struct {
    OriginTaskID string
    SpecJSON     json.RawMessage
    WorktreeID   string
}

type StartCoordinatorRun struct {
    repo       CoordinatorRunRepository
    serializer HandleSerializer
}

func (uc *StartCoordinatorRun) Execute(ctx context.Context, in StartCoordinatorRunInput) (domain.CoordinatorRun, error) {
    tenantID, err := tenant.RequireTenantID(ctx)
    if err != nil {
        return domain.CoordinatorRun{}, apperrors.New(apperrors.KindUnauthenticated, "ORCH_NO_TENANT", "no tenant in request context", err)
    }
    if in.OriginTaskID == "" {
        return domain.CoordinatorRun{}, apperrors.New(apperrors.KindInvalidArgument, "ORCH_EMPTY_ORIGIN_TASK_ID", "origin_task_id is required", nil)
    }

    coordinatorHandle := "coordinator:" + uuid.NewString() // mailbox identity for this run; format matches assignee_handle's informal "kind:id" convention elsewhere in this service
    run, err := domain.NewCoordinatorRun("", tenantID, in.OriginTaskID, coordinatorHandle, in.SpecJSON, 0)
    if err != nil {
        return domain.CoordinatorRun{}, apperrors.New(apperrors.KindInvalidArgument, "ORCH_INVALID_RUN", "invalid coordinator run", err)
    }
    run.Status = domain.RunStatusRunning // NewCoordinatorRun defaults to Idle; StartCoordinatorRun's whole point is starting it immediately

    var out domain.CoordinatorRun
    err = uc.serializer.Do(ctx, in.OriginTaskID, func() error {
        // ExpandSpec needs the run's id, but the repository mints it on
        // INSERT — resolved by having CreateWithTasks itself call
        // ExpandSpec with the id it just generated, inside its own
        // transaction (see repository design below), NOT here. This
        // usecase validates spec_json shape early (fail fast, clear
        // error) via a throwaway ExpandSpec call with a placeholder id,
        // then hands the real expansion to the repository.
        if _, err := domain.ExpandSpec(tenantID, "placeholder", in.OriginTaskID, in.SpecJSON); err != nil {
            return err
        }
        created, err := uc.repo.CreateWithTasks(ctx, tenantID, run, nil /* repo re-derives via ExpandSpec with its own minted id */)
        if err != nil {
            return err
        }
        out = created
        return nil
    })
    if err != nil {
        var domainErr *apperrors.Error // ExpandSpec's sentinel errors surface as-is
        if errors.As(err, &domainErr) {
            return domain.CoordinatorRun{}, err
        }
        return domain.CoordinatorRun{}, apperrors.New(apperrors.KindInvalidArgument, "ORCH_INVALID_SPEC", "spec_json is invalid", err)
    }
    return out, nil
}
```

```go
// internal/usecase/complete_coordinator_run.go and fail_coordinator_run.go
// follow UpdateTaskStatusAndPromote's exact shape (tenant check -> empty-id
// check -> serializer.Do keyed by run id -> repo call -> apperrors mapping)
// — omitted here to avoid restating the same boilerplate 3 times; the only
// domain-specific line in each is the repo call:
//   uc.repo.Complete(ctx, tenantID, in.ID, in.ResultJSON)
//   uc.repo.Fail(ctx, tenantID, in.ID, in.ErrorMessage)
// Both are ALSO called internally (not just via RPC) by the
// UpdateTaskStatusAndPromote extension below — exposed as usecases (not
// unexported repo calls) specifically so an operator/admin path can also
// force-fail a stuck run without waiting for the tick loop, per
// orchestration-service.md §3 listing FailCoordinatorRun as a
// caller-invokable RPC, not only an internal transition.
```

```go
// internal/usecase/record_heartbeat.go — mirrors §8's "no cross-service
// calls, p99 < 30ms" budget: no serializer, no transaction, single UPDATE.
func (uc *RecordHeartbeat) Execute(ctx context.Context, dispatchContextID string) (domain.DispatchContext, error) {
    tenantID, err := tenant.RequireTenantID(ctx)
    if err != nil { return domain.DispatchContext{}, apperrors.New(apperrors.KindUnauthenticated, "ORCH_NO_TENANT", "no tenant in request context", err) }
    if dispatchContextID == "" { return domain.DispatchContext{}, apperrors.New(apperrors.KindInvalidArgument, "ORCH_EMPTY_DISPATCH_CONTEXT_ID", "dispatch_context_id is required", nil) }
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

```go
// internal/usecase/list_pending_decision_gates.go — read-only, mirrors
// ListActiveDispatchContextsForUser.go's shape exactly (tenant from
// identity, no other input).
func (uc *ListPendingDecisionGates) Execute(ctx context.Context) ([]domain.DecisionGate, error) {
    tenantID, err := tenant.RequireTenantID(ctx)
    if err != nil { return nil, apperrors.New(apperrors.KindUnauthenticated, "ORCH_NO_TENANT", "no tenant in request context", err) }
    return uc.repo.ListPending(ctx, tenantID)
}
```

## Design — `UpdateTaskStatusAndPromote` extension: detecting run completion

This is the piece that turns "promotion happens when asked" into "the run
finishes itself" — folded into the EXISTING atomic transaction rather than
a second round-trip, per the same reasoning §8 gives for the promote saga
itself (a torn read between "promotion committed" and "check if the run is
now done" could leave a fully-completed run stuck `running` forever if the
process crashes between the two steps):

```go
// internal/adapter/postgres/repository.go — UpdateStatusAndPromote, extended
// (existing BEGIN...COMMIT body unchanged up to the promote step; new tail
// added before COMMIT):
func (r *Repository) UpdateStatusAndPromote(ctx context.Context, tenantID, taskID string, newStatus domain.TaskStatus) (domain.OrchestrationTask, []string, error) {
    // ... existing update + promoteReadySiblings unchanged ...

    // NEW: only a completed/failed leaf transition can possibly finish a
    // run — skip the extra query on every other status write (ready/
    // dispatched/blocked transitions can never be the LAST event of a run).
    if newStatus == domain.TaskStatusCompleted || newStatus == domain.TaskStatusFailed {
        var nonTerminal int
        if err := tx.QueryRow(ctx, `
            SELECT count(*) FROM orchestration.orchestration_tasks
            WHERE coordinator_run_id = $1 AND tenant_id = $2
              AND status NOT IN ('completed', 'failed')`,
            task.CoordinatorRunID, tenantID).Scan(&nonTerminal); err != nil {
            return domain.OrchestrationTask{}, nil, fmt.Errorf("count non-terminal: %w", err)
        }
        if nonTerminal == 0 {
            // Every sibling in this run is now terminal. A single failed
            // leaf fails the WHOLE run (fail-closed: a partially-succeeded
            // multi-agent DAG is not a usable result for task-service's
            // ReportTaskExecutionResult, which only accepts success/failure,
            // not partial) — same "any failure -> whole thing failed" rule
            // SOL-TG-04's own ReportTaskExecutionResult callback expects.
            var anyFailed bool
            if err := tx.QueryRow(ctx, `
                SELECT exists(SELECT 1 FROM orchestration.orchestration_tasks
                    WHERE coordinator_run_id = $1 AND tenant_id = $2 AND status = 'failed')`,
                task.CoordinatorRunID, tenantID).Scan(&anyFailed); err != nil {
                return domain.OrchestrationTask{}, nil, fmt.Errorf("check any-failed: %w", err)
            }
            runStatus := "completed"
            if anyFailed {
                runStatus = "failed"
            }
            if _, err := tx.Exec(ctx, `
                UPDATE orchestration.coordinator_runs SET status = $1, completed_at = now()
                WHERE id = $2 AND tenant_id = $3 AND status = 'running'`,
                runStatus, task.CoordinatorRunID, tenantID); err != nil {
                return domain.OrchestrationTask{}, nil, fmt.Errorf("finalize run: %w", err)
            }
            // Report-to-task-service happens OUTSIDE this transaction (see
            // usecase change below) — a cross-service gRPC call must never
            // hold a DB transaction open (05-data-architecture.md's
            // no-cross-service-call-in-txn rule, applied elsewhere in this
            // service per §8's "no cross-service calls on that [heartbeat]
            // path" note extended to this path by the same logic).
        }
    }
    // ... existing COMMIT unchanged ...
}
```

The usecase layer (`UpdateTaskStatusAndPromote.Execute`) is extended to
read the returned task's terminal run status (a new
`RunFinalized *domain.RunFinalization` field on
`UpdateTaskStatusAndPromoteOutput`, populated only when the tail above
fired) and, if set, call `TaskServiceReporter.ReportResult(...)`
**after** the transaction commits successfully — matching
`ReportTaskExecutionResult`'s own idempotence note (SOL-TG-04: "ignored,
not an error... at-least-once consumer idempotence") so a reporter-call
failure here is logged and retried by the tick loop's next pass (which
re-checks `coordinator_runs` for `status IN ('completed','failed')` rows
with no successful report yet — tracked via a `reported_at` column, see
migration below) rather than losing the terminal-state notification
silently.

## Design — the tick loop (`main.go`)

```go
// cmd/server/main.go — additive: a third background goroutine alongside
// the existing grpc/http listeners (main.go:112-129), matching this
// file's existing goroutine+errCh pattern exactly rather than introducing
// a new lifecycle mechanism.
tickCtx, tickCancel := context.WithCancel(context.Background())
defer tickCancel()
go func() {
    ticker := time.NewTicker(2 * time.Second) // matches domain.defaultPollIntervalMs; a per-run poll_interval_ms is stored but this scaffold's tick loop runs one global cadence — see "Not in scope" below for the per-run-interval refinement
    defer ticker.Stop()
    for {
        select {
        case <-tickCtx.Done():
            return
        case <-ticker.C:
            if err := tickDispatchUC.Execute(context.Background()); err != nil {
                logger.Error("tick dispatch failed", slog.Any("error", err))
                // Deliberately does NOT stop the ticker or exit the
                // process — one failed tick (e.g. a transient Postgres
                // blip) must not take down the whole coordinator; the
                // next tick retries the same ClaimReady scan.
            }
        }
    }
}()
```

```go
// internal/usecase/tick_dispatch.go (new)
// TickDispatch is the ONE usecase the tick loop calls per interval. It has
// no gRPC-facing counterpart — it is the internal engine
// orchestration-service.md §2.2 describes as "the coordinator then
// autonomously ticking the run's state machine."
type TickDispatch struct {
    tasks      OrchestrationTaskRepository
    dispatch   *CreateDispatchContext // reused as-is, not reimplemented
    worker     WorkerDispatcher
    fail       *FailDispatch // reused as-is for a dispatch call that errors
}

func (uc *TickDispatch) Execute(ctx context.Context) error {
    ready, err := uc.tasks.ListReadyUnclaimed(ctx)
    if err != nil {
        return fmt.Errorf("tick: list ready tasks: %w", err)
    }
    for _, task := range ready {
        claimed, ok, err := uc.tasks.ClaimReady(ctx, task.TenantID, task.ID)
        if err != nil {
            slog.Error("tick: claim failed", slog.String("task_id", task.ID), slog.Any("error", err))
            continue // one task's claim failure must not abort the whole batch
        }
        if !ok {
            continue // lost the race to another tick/instance — not an error
        }
        handle := "worker:" + claimed.ID // one worker per orchestration_task, per orchestration-service.md §4's DispatchContext.assignee_handle shape
        dc, err := uc.dispatch.Execute(ctx, CreateDispatchContextInput{
            Handle: handle, CoordinatorRunID: claimed.CoordinatorRunID, OrchestrationTaskID: claimed.ID,
        })
        if err != nil {
            slog.Error("tick: create dispatch context failed", slog.String("task_id", claimed.ID), slog.Any("error", err))
            continue // task stays 'dispatched' with no dispatch_context row; a future reconciliation pass (see "Not in scope") is the flagged follow-up, not solved here
        }
        if err := uc.worker.Dispatch(ctx, claimed.TenantID, claimed, handle); err != nil {
            // Real, permanent-until-retried dispatch failure — record it
            // via the EXISTING FailDispatch usecase (circuit-breaker logic
            // reused unmodified, per this solution's "what already exists" note).
            _, _ = uc.fail.Execute(ctx, FailDispatchInput{DispatchContextID: dc.ID, ErrorMessage: err.Error(), GRPCStatusCode: uint32(status.Code(err))})
            continue
        }
    }
    return nil
}
```

`WorkerDispatcher`'s concrete adapter
(`internal/adapter/infrafleetclient/worker_dispatcher.go`) follows
`task-service`'s existing `SimpleExecutor.Execute`
(`simple_executor.go:132-193`) pattern byte-for-byte: resolve a
`connectionId` for the task's target (from `claimed.Spec`'s own
`{connectionId}` field — NOT re-resolved here; connection targeting is
`task-service`'s `ProjectExecutionResolver`'s job upstream, already
baked into the spec at `buildOrchestrationSpec` time, matching
`orchestration-service.md §7`'s "does not decide decomposition
strategy") and relay a prompt via `infrafleetv1.InfraFleetServiceClient` —
this is a call-site reuse, not a new resolution mechanism, so it is not
re-specified line-by-line here.

## Design — migration

```sql
-- backend-go/services/orchestration-service/migrations/0004_coordinator_run_lifecycle.up.sql
ALTER TABLE orchestration.coordinator_runs
  ADD COLUMN worktree_id   TEXT,                 -- optional, same nullable pattern as dispatch_contexts.worktree_id (0003)
  ADD COLUMN result        JSONB,                 -- set by CompleteCoordinatorRun / the UpdateTaskStatusAndPromote extension
  ADD COLUMN error_message TEXT,                  -- set by FailCoordinatorRun
  ADD COLUMN reported_at   TIMESTAMPTZ;            -- set once TaskServiceReporter.ReportResult succeeds — lets a retry pass find runs whose terminal state was persisted but never successfully reported (see "UpdateTaskStatusAndPromote extension" above)

CREATE INDEX idx_coordinator_runs_unreported
  ON orchestration.coordinator_runs (status)
  WHERE status IN ('completed', 'failed') AND reported_at IS NULL;
```

```sql
-- 0004_coordinator_run_lifecycle.down.sql
DROP INDEX IF EXISTS orchestration.idx_coordinator_runs_unreported;
ALTER TABLE orchestration.coordinator_runs
  DROP COLUMN IF EXISTS reported_at,
  DROP COLUMN IF EXISTS error_message,
  DROP COLUMN IF EXISTS result,
  DROP COLUMN IF EXISTS worktree_id;
```

No migration is needed for `orchestration_tasks`/`dispatch_contexts`/
`decision_gates` — every column this solution's usecases read/write on
those tables already exists (confirmed against `0001_init.up.sql:28-95`).

## Test plan

- `domain/orchestration_test.go` — `CoordinatorRun.Complete`/`Fail`: valid
  transition from `running`; `Fail` also valid from `idle`; both reject a
  run already `completed`/`failed` (`ErrRunNotRunning`).
- `domain/spec_test.go` (new) — `ExpandSpec`: single-node spec with no deps
  → one task, `TaskStatusReady`; multi-node spec with a dep chain → only
  the no-dep node(s) start `ready`, the rest `pending`; duplicate `tempId`
  → `ErrDuplicateTempID`; a `deps` entry naming an unknown `tempId` →
  `ErrDanglingDep`; empty node array → `ErrEmptySpec`; malformed JSON →
  wrapped error, not a panic.
- `usecase/start_coordinator_run_test.go` (new, fake `CoordinatorRunRepository`) —
  happy path returns a `RunStatusRunning` run; invalid `spec_json` returns
  `KindInvalidArgument` without calling the repository at all (fail fast);
  missing tenant → `KindUnauthenticated`.
- `usecase/complete_coordinator_run_test.go`, `fail_coordinator_run_test.go` (new) —
  mirror `update_task_status_and_promote_test.go`'s existing structure:
  happy path, not-found, empty-id validation.
- `usecase/record_heartbeat_test.go` (new) — happy path updates
  `LastHeartbeatAt`; not-found path.
- `usecase/list_pending_decision_gates_test.go` (new) — returns only
  `GateStatusPending` rows for the caller's tenant (fake repo pre-seeded
  with a mix of pending/resolved gates across two tenants).
- `usecase/update_task_status_and_promote_test.go` (extend) — new cases:
  completing the LAST non-terminal task in a run triggers
  `RunFinalized` with `status=completed`; completing a task while siblings
  remain `pending` does NOT trigger it; a run where one task ends
  `failed` and all others `completed` finalizes the run as `failed`, not
  `completed` (fail-closed rule above) — every existing case in this file
  must still pass unmodified (regression guard).
- `usecase/tick_dispatch_test.go` (new, fakes for `OrchestrationTaskRepository`/
  `WorkerDispatcher`) — a ready+unclaimed task gets `ClaimReady`'d,
  dispatched, and `CreateDispatchContext`'d exactly once; two tasks racing
  for the same `ClaimReady` (fake returns `ok=false` on the second call)
  results in exactly one dispatch; a `WorkerDispatcher.Dispatch` error
  routes to `FailDispatch` with the task's dispatch-context id, not left
  silently dropped; a `ListReadyUnclaimed` error surfaces from `Execute`
  without dispatching anything.
- `adapter/postgres/repository_test.go` (extend) — `CreateWithTasks`
  round-trips a multi-node `ExpandSpec` output with dep resolution intact
  (a child's `Deps` correctly resolve from `tempId` strings to the
  parent's real minted UUID); `ClaimReady` under concurrent goroutines
  claiming the same row — exactly one succeeds (uses a real Postgres test
  container per this package's existing convention, not fakes, since this
  is exactly the CAS race the design depends on); `ListPending` returns
  only `pending` rows, respects the partial index's own filter.
- Integration-level (new, `orchestration-service`'s existing test-harness
  convention if one exists, else a new `cmd/server` smoke test): a full
  `StartCoordinatorRun` → tick loop dispatches the ready root → (a fake
  `WorkerDispatcher` immediately calls back `UpdateTaskStatusAndPromote`
  with `completed`) → run auto-finalizes to `completed` → `TaskServiceReporter.ReportResult`
  called exactly once with `success=true`.

## Not in scope (flagged, not solved here)

- **Per-run `poll_interval_ms`**: `CoordinatorRun.PollIntervalMs` is
  already modeled but this solution's tick loop runs one global 2s
  cadence for every run, ignoring the per-run field — matching this
  bug's own scope (get the loop existing and correct first); honoring
  per-run intervals would need either N independent tickers or a
  min-heap scheduler, deferred as a follow-up once a real workload shows
  the global cadence is actually a problem.
- **Dead-worker reaping via `last_heartbeat_at` staleness**: `RecordHeartbeat`
  is designed and wired, but nothing yet scans for a `dispatched` task
  whose `last_heartbeat_at` has gone stale and force-fails it — the same
  kind of explicitly-flagged, deliberately-deferred gap
  `orchestration-service.md §10`'s own `GetAgentStatusForHandle` note
  models; recorded here the same way rather than silently assumed away.
- **`PostMessage`/`ListMessages`/`MarkMessageRead`/`orchestration.messages`**:
  still dead schema after this solution — BUG-TASKV1-005 counts these
  separately from the 11-RPC set this solution closes (see the bug's own
  §"Net" accounting), and nothing in this design's dispatch/promotion path
  depends on the mailbox table. Left as a distinct, later gap.
- **`GetAgentStatusForHandle`**: unrelated read RPC,
  `orchestration-service.md §10`'s own already-flagged decision point —
  not touched by this solution.
- **A reconciliation pass for a `ClaimReady`-succeeded-but-`CreateDispatchContext`-failed
  task** (left `dispatched` with no dispatch_context row, noted inline in
  `TickDispatch.Execute` above): flagged, not designed — this is a narrow
  edge case (a DB write failing immediately after a successful CAS update
  a moment earlier) rather than a normal-path gap, and a reconciliation
  sweep's design depends on operational data about how often it actually
  happens.

## References

- `specs/backend-go/tdd/services/orchestration-service.md:1-337` — full TDD; §2 (bounded context/id-space), §3 (11-RPC sketch), §4 (domain model), §5 (schema), §6 (KeyedAsyncQueue), §7 (dependencies), §8 (atomicity NFRs, quoted throughout this design), §10 (migration notes, `GetAgentStatusForHandle` flagged-gap precedent this solution's own "Not in scope" section follows)
- `backend-go/proto/orca/orchestration/v1/orchestration.proto:1-179` — current 7-RPC surface, full file read
- `backend-go/services/orchestration-service/internal/domain/orchestration.go:1-341` — full current domain layer (`CoordinatorRun` at 306-340, `OrchestrationTask`/`DepsSatisfied` at 60-124, `DecisionGate.Resolve`'s one-way-door pattern at 272-282 this solution's `Complete`/`Fail` methods mirror)
- `backend-go/services/orchestration-service/internal/usecase/ports.go:1-125` — full current ports file, extended by this solution
- `backend-go/services/orchestration-service/internal/usecase/update_task_status_and_promote.go:1-79`, `create_dispatch_context.go:1-64`, `fail_dispatch.go:1-82` — existing usecases this solution's new usecases mirror in shape and reuses unmodified where noted
- `backend-go/services/orchestration-service/internal/adapter/postgres/repository.go:44-95,99-225,251-455` — `Create`/`Get`/`UpdateStatusAndPromote`/`CreateDispatchContext`/`RecordDispatchFailure`/`CreateGate`/`ResolveGate`, the transaction patterns this solution's new repository methods follow
- `backend-go/services/orchestration-service/migrations/0001_init.up.sql:1-121`, `0002_dispatch_context_user_id.up.sql`, `0003_dispatch_context_worktree_id.up.sql` — existing schema + the additive-migration precedent `0004` follows
- `backend-go/services/orchestration-service/cmd/server/main.go:1-147` — full current composition root, confirms no ticker/scheduler goroutine exists today (the gap this solution's tick-loop addition closes)
- `specs/backend-go/bugs/logic-v1/solutions/SOL-TG-04-task-agent-execution.md:157-254` — the `task-service`-side `ComplexExecutor`/`StartCoordinatorRun` CLIENT call and `ReportTaskExecutionResult` SERVER handler this solution's `StartCoordinatorRun` SERVER handler and `TaskServiceReporter` CLIENT stub are the other end of; not redesigned here, only the interface shape (`StartCoordinatorRunRequest{TenantId, OriginTaskId, Spec, WorktreeId}`, `ReportTaskExecutionResultRequest{TaskID, CoordinatorRunID, Success, ActualHours, ErrorMessage}`) is treated as fixed by this solution's own proto/port designs
- `backend-go/services/task-service/internal/adapter/grpcclient/simple_executor.go:132-193` — the existing infra-fleet-service relay pattern `WorkerDispatcher`'s concrete adapter reuses
- [BUG-TASKV1-004](../BUG-TASKV1-004-orcatask-run-agent-execution-gaps.md) / [SOL-TASKV1-004](./SOL-TASKV1-004-orcatask-run-agent-execution-gaps.md) — the `task-service`-side gap this solution unblocks (TASK-TG-04-04's real `ComplexExecutor` cannot land until `StartCoordinatorRun` exists here)
