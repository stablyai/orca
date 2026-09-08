// Package domain holds orchestration-service's entities and value objects.
// Per specs/backend-go/architecture/03-clean-architecture-guidelines.md,
// this package has zero imports outside stdlib + other domain/ packages —
// no database, no gRPC, no framework.
//
// orchestration_tasks is this service's OWN DAG-node id space, deliberately
// distinct from task-service's tasks table — see
// specs/backend-go/services/orchestration-service.md §2.1. The two link
// only via opaque-string logical FKs (OriginTaskID here), never a SQL FK.
package domain

import (
	"encoding/json"
	"errors"
	"time"
)

// ---- OrchestrationTask -----------------------------------------------

// TaskStatus is the state-machine status of one DAG node in a
// coordinator_run — see orchestration-service.md §4.
type TaskStatus string

const (
	TaskStatusPending    TaskStatus = "pending"
	TaskStatusReady      TaskStatus = "ready"
	TaskStatusDispatched TaskStatus = "dispatched"
	TaskStatusCompleted  TaskStatus = "completed"
	TaskStatusFailed     TaskStatus = "failed"
	TaskStatusBlocked    TaskStatus = "blocked"
)

// Valid reports whether s is one of the known enum values.
func (s TaskStatus) Valid() bool {
	switch s {
	case TaskStatusPending, TaskStatusReady, TaskStatusDispatched,
		TaskStatusCompleted, TaskStatusFailed, TaskStatusBlocked:
		return true
	default:
		return false
	}
}

var (
	// ErrEmptyCoordinatorRunID guards the FK every orchestration_task row
	// must carry — a task minted outside a coordinator_run is meaningless.
	ErrEmptyCoordinatorRunID = errors.New("domain: coordinator_run_id is required")
	// ErrEmptyTaskTitle guards against an untitled DAG node.
	ErrEmptyTaskTitle = errors.New("domain: task_title is required")
	// ErrInvalidTaskStatus is returned when a caller supplies a status
	// outside the closed enum (e.g. from an un-validated RPC string field).
	ErrInvalidTaskStatus = errors.New("domain: invalid task status")
	// ErrSelfDependency guards the "deps may only reference sibling ids"
	// invariant (orchestration-service.md §4) against the degenerate case
	// of a task depending on itself, which would make it permanently
	// unpromotable.
	ErrSelfDependency = errors.New("domain: a task cannot depend on itself")
)

// OrchestrationTask is the Go/Postgres equivalent of TS's TaskRow — named
// OrchestrationTask, not Task, specifically to avoid conflation with
// task-service's entity (orchestration-service.md §4).
type OrchestrationTask struct {
	ID               string
	TenantID         string
	CoordinatorRunID string
	ParentID         string // empty for the DAG root
	OriginTaskID     string // logical FK -> task-service.Task.id, root row only
	TaskTitle        string
	Spec             json.RawMessage
	Status           TaskStatus
	Deps             []string // sibling ids within the same CoordinatorRunID, drives promotion
	Result           json.RawMessage
	CreatedAt        time.Time
	CompletedAt      time.Time
}

// NewOrchestrationTask constructs an OrchestrationTask in TaskStatusPending,
// enforcing the invariants that make a DAG node meaningful.
func NewOrchestrationTask(
	id, tenantID, coordinatorRunID, parentID, originTaskID, taskTitle string,
	spec json.RawMessage,
	deps []string,
) (OrchestrationTask, error) {
	if coordinatorRunID == "" {
		return OrchestrationTask{}, ErrEmptyCoordinatorRunID
	}
	if taskTitle == "" {
		return OrchestrationTask{}, ErrEmptyTaskTitle
	}
	if id != "" {
		for _, d := range deps {
			if d == id {
				return OrchestrationTask{}, ErrSelfDependency
			}
		}
	}
	return OrchestrationTask{
		ID:               id,
		TenantID:         tenantID,
		CoordinatorRunID: coordinatorRunID,
		ParentID:         parentID,
		OriginTaskID:     originTaskID,
		TaskTitle:        taskTitle,
		Spec:             spec,
		Status:           TaskStatusPending,
		Deps:             deps,
	}, nil
}

// DepsSatisfied reports whether every id in t.Deps is present in completed.
// This is the pure promotion rule — the atomic UpdateStatusAndPromote
// transaction (orchestration-service.md §8) applies the same rule per row
// inside SQL; kept here too so the rule itself is unit-testable without a
// database, and reused by internal/adapter/postgres to keep the two
// implementations of "is this task ready" from drifting apart.
func (t OrchestrationTask) DepsSatisfied(completed map[string]struct{}) bool {
	for _, d := range t.Deps {
		if _, ok := completed[d]; !ok {
			return false
		}
	}
	return true
}

// ---- DispatchContext ---------------------------------------------------

// DispatchStatus is the liveness/outcome state of one dispatch attempt.
type DispatchStatus string

const (
	DispatchStatusPending       DispatchStatus = "pending"
	DispatchStatusDispatched    DispatchStatus = "dispatched"
	DispatchStatusCompleted     DispatchStatus = "completed"
	DispatchStatusFailed        DispatchStatus = "failed"
	DispatchStatusCircuitBroken DispatchStatus = "circuit_broken"
)

// circuitBreakerThreshold is the failure_count at which a dispatch is
// force-transitioned to circuit_broken, per orchestration-service.md §4 —
// blocks further dispatch attempts without a manual reset.
const circuitBreakerThreshold = 3

// ErrEmptyHandle guards against a dispatch context with no assignee.
var ErrEmptyHandle = errors.New("domain: assignee_handle is required")

// DispatchContext tracks one dispatch attempt of an OrchestrationTask to a
// terminal-hosted AI-agent worker, identified by Handle.
type DispatchContext struct {
	ID       string
	TenantID string
	// UserID is the caller who initiated this dispatch (from the
	// authenticated identity at CreateDispatchContext time, never a
	// client-supplied field) — added for CR-STORAGE-006/007's
	// "list active dispatch contexts for the current user" need. Nullable:
	// a dispatch context created by a system process with no end-user
	// caller legitimately has none. See
	// specs/backlog/BACKLOG-006-dispatch-context-user-linkage-decision.md
	// for why this lives here rather than on coordinator_runs.
	UserID string
	// OrchestrationTaskID is the owning task. May be empty in this
	// scaffold — see README "Known gaps": the generated
	// CreateDispatchContextRequest proto message does not carry an
	// orchestration_task_id.
	OrchestrationTaskID string
	Handle              string
	CoordinatorRunID    string
	Status              DispatchStatus
	FailureCount        int32
	LastFailure         string
	DispatchedAt        time.Time
	CompletedAt         time.Time
	LastHeartbeatAt     time.Time
	CreatedAt           time.Time
}

// NewDispatchContext constructs a DispatchContext in DispatchStatusPending.
func NewDispatchContext(id, tenantID, userID, orchestrationTaskID, handle, coordinatorRunID string) (DispatchContext, error) {
	if handle == "" {
		return DispatchContext{}, ErrEmptyHandle
	}
	return DispatchContext{
		ID:                  id,
		TenantID:            tenantID,
		UserID:              userID,
		OrchestrationTaskID: orchestrationTaskID,
		Handle:              handle,
		CoordinatorRunID:    coordinatorRunID,
		Status:              DispatchStatusPending,
	}, nil
}

// RecordFailure returns the DispatchContext after incrementing its failure
// count, force-tripping the circuit breaker once the threshold is reached
// — the invariant from orchestration-service.md §4: "failure_count >= 3
// forces circuit_broken, blocking dispatch without manual reset."
func (d DispatchContext) RecordFailure(reason string) DispatchContext {
	d.FailureCount++
	d.LastFailure = reason
	if d.FailureCount >= circuitBreakerThreshold {
		d.Status = DispatchStatusCircuitBroken
	} else {
		d.Status = DispatchStatusFailed
	}
	return d
}

// ---- DecisionGate --------------------------------------------------

// GateStatus is the resolution state of a human decision checkpoint.
type GateStatus string

const (
	GateStatusPending  GateStatus = "pending"
	GateStatusResolved GateStatus = "resolved"
	GateStatusTimeout  GateStatus = "timeout"
)

var (
	// ErrEmptyOrchestrationTaskID guards the FK every gate row must carry.
	ErrEmptyOrchestrationTaskID = errors.New("domain: orchestration_task_id is required")
	// ErrGateAlreadyResolved is the core invariant this service must hold:
	// a gate is a single-shot transition, never resolved twice. Per
	// orchestration-service.md §4, "a task with an unresolved gate cannot
	// reach dispatched/completed" only makes sense if resolution is a
	// one-way door — a second resolution could unblock a task the first
	// resolution's caller believed they were still gating.
	ErrGateAlreadyResolved = errors.New("domain: gate is already resolved")
)

// DecisionGate is a human decision checkpoint blocking one OrchestrationTask.
type DecisionGate struct {
	ID                  string
	TenantID            string
	OrchestrationTaskID string
	DispatchContextID   string // nullable; see README known-gap re: proto round-trip
	Question            string
	Options             []string
	Status              GateStatus
	Resolution          string
	CreatedAt           time.Time
	ResolvedAt          time.Time
}

// NewDecisionGate constructs a DecisionGate in GateStatusPending.
func NewDecisionGate(id, tenantID, orchestrationTaskID, dispatchContextID, question string, options []string) (DecisionGate, error) {
	if orchestrationTaskID == "" {
		return DecisionGate{}, ErrEmptyOrchestrationTaskID
	}
	return DecisionGate{
		ID:                  id,
		TenantID:            tenantID,
		OrchestrationTaskID: orchestrationTaskID,
		DispatchContextID:   dispatchContextID,
		Question:            question,
		Options:             options,
		Status:              GateStatusPending,
	}, nil
}

// Resolve transitions a pending gate to resolved, returning
// ErrGateAlreadyResolved if it has already left the pending state (resolved
// or timed out) — enforcing the "resolved exactly once" invariant.
func (g DecisionGate) Resolve(resolution string) (DecisionGate, error) {
	if g.Status != GateStatusPending {
		return DecisionGate{}, ErrGateAlreadyResolved
	}
	g.Status = GateStatusResolved
	g.Resolution = resolution
	return g, nil
}

// ---- CoordinatorRun --------------------------------------------------

// RunStatus is the top-level lifecycle state of one coordinator session.
type RunStatus string

const (
	RunStatusIdle      RunStatus = "idle"
	RunStatusRunning   RunStatus = "running"
	RunStatusCompleted RunStatus = "completed"
	RunStatusFailed    RunStatus = "failed"
)

const defaultPollIntervalMs = 2000

var (
	// ErrEmptyOriginTaskID guards the logical FK to task-service's task.
	ErrEmptyOriginTaskID = errors.New("domain: origin_task_id is required")
	// ErrEmptyCoordinatorHandle guards against a run with no coordinator
	// mailbox identity to address messages to.
	ErrEmptyCoordinatorHandle = errors.New("domain: coordinator_handle is required")
)

// CoordinatorRun is one top-level "complex path" coordination session — the
// DAG root and every descendant OrchestrationTask share its id.
type CoordinatorRun struct {
	ID                string
	TenantID          string
	OriginTaskID      string // logical FK -> task-service.Task.id
	Spec              json.RawMessage
	Status            RunStatus
	CoordinatorHandle string
	PollIntervalMs    int32
	CreatedAt         time.Time
	CompletedAt       time.Time
}

// NewCoordinatorRun constructs a CoordinatorRun in RunStatusIdle.
func NewCoordinatorRun(id, tenantID, originTaskID, coordinatorHandle string, spec json.RawMessage, pollIntervalMs int32) (CoordinatorRun, error) {
	if originTaskID == "" {
		return CoordinatorRun{}, ErrEmptyOriginTaskID
	}
	if coordinatorHandle == "" {
		return CoordinatorRun{}, ErrEmptyCoordinatorHandle
	}
	if pollIntervalMs <= 0 {
		pollIntervalMs = defaultPollIntervalMs
	}
	return CoordinatorRun{
		ID:                id,
		TenantID:          tenantID,
		OriginTaskID:      originTaskID,
		Spec:              spec,
		Status:            RunStatusIdle,
		CoordinatorHandle: coordinatorHandle,
		PollIntervalMs:    pollIntervalMs,
	}, nil
}
