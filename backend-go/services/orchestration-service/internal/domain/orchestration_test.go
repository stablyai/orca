package domain

import (
	"errors"
	"testing"
)

func TestNewOrchestrationTask_ValidatesInvariants(t *testing.T) {
	if _, err := NewOrchestrationTask("t1", "tenant-1", "", "", "", "Do the thing", nil, nil); !errors.Is(err, ErrEmptyCoordinatorRunID) {
		t.Fatalf("expected ErrEmptyCoordinatorRunID, got %v", err)
	}
	if _, err := NewOrchestrationTask("t1", "tenant-1", "run-1", "", "", "", nil, nil); !errors.Is(err, ErrEmptyTaskTitle) {
		t.Fatalf("expected ErrEmptyTaskTitle, got %v", err)
	}
	if _, err := NewOrchestrationTask("t1", "tenant-1", "run-1", "", "", "title", nil, []string{"t1"}); !errors.Is(err, ErrSelfDependency) {
		t.Fatalf("expected ErrSelfDependency, got %v", err)
	}
	task, err := NewOrchestrationTask("t1", "tenant-1", "run-1", "", "", "title", nil, []string{"t0"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if task.Status != TaskStatusPending {
		t.Errorf("expected new task to start pending, got %s", task.Status)
	}
}

func TestOrchestrationTask_DepsSatisfied(t *testing.T) {
	task, err := NewOrchestrationTask("t2", "tenant-1", "run-1", "", "", "title", nil, []string{"t0", "t1"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if task.DepsSatisfied(map[string]struct{}{"t0": {}}) {
		t.Error("expected DepsSatisfied to be false when a dep is missing")
	}
	if !task.DepsSatisfied(map[string]struct{}{"t0": {}, "t1": {}, "other": {}}) {
		t.Error("expected DepsSatisfied to be true when all deps are present")
	}

	root, err := NewOrchestrationTask("t3", "tenant-1", "run-1", "", "", "root", nil, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !root.DepsSatisfied(nil) {
		t.Error("expected a task with no deps to always be satisfied")
	}
}

func TestTaskStatus_Valid(t *testing.T) {
	valid := []TaskStatus{TaskStatusPending, TaskStatusReady, TaskStatusDispatched, TaskStatusCompleted, TaskStatusFailed, TaskStatusBlocked}
	for _, s := range valid {
		if !s.Valid() {
			t.Errorf("expected %s to be valid", s)
		}
	}
	if TaskStatus("bogus").Valid() {
		t.Error("expected an unknown status to be invalid")
	}
}

func TestDispatchContext_RecordFailure_TripsCircuitBreakerAtThreshold(t *testing.T) {
	d, err := NewDispatchContext("d1", "tenant-1", "user-1", "t1", "handle-1", "run-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	d = d.RecordFailure("timeout")
	if d.Status != DispatchStatusFailed {
		t.Fatalf("expected status failed after 1 failure, got %s", d.Status)
	}
	d = d.RecordFailure("timeout")
	if d.Status != DispatchStatusFailed {
		t.Fatalf("expected status failed after 2 failures, got %s", d.Status)
	}
	d = d.RecordFailure("timeout")
	if d.Status != DispatchStatusCircuitBroken {
		t.Fatalf("expected status circuit_broken after 3 failures, got %s", d.Status)
	}
	if d.FailureCount != 3 {
		t.Errorf("expected FailureCount=3, got %d", d.FailureCount)
	}
}

func TestNewDispatchContext_RequiresHandle(t *testing.T) {
	if _, err := NewDispatchContext("d1", "tenant-1", "user-1", "t1", "", "run-1"); !errors.Is(err, ErrEmptyHandle) {
		t.Fatalf("expected ErrEmptyHandle, got %v", err)
	}
}

func TestDecisionGate_CannotBeResolvedTwice(t *testing.T) {
	gate, err := NewDecisionGate("g1", "tenant-1", "t1", "d1", "proceed?", []string{"yes", "no"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	resolved, err := gate.Resolve("yes")
	if err != nil {
		t.Fatalf("unexpected error resolving a pending gate: %v", err)
	}
	if resolved.Status != GateStatusResolved || resolved.Resolution != "yes" {
		t.Fatalf("expected resolved gate with resolution=yes, got status=%s resolution=%s", resolved.Status, resolved.Resolution)
	}

	if _, err := resolved.Resolve("no"); !errors.Is(err, ErrGateAlreadyResolved) {
		t.Fatalf("expected ErrGateAlreadyResolved on a second resolution, got %v", err)
	}
}

func TestDecisionGate_TimedOutGateCannotBeResolved(t *testing.T) {
	gate, err := NewDecisionGate("g1", "tenant-1", "t1", "d1", "proceed?", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	gate.Status = GateStatusTimeout

	if _, err := gate.Resolve("yes"); !errors.Is(err, ErrGateAlreadyResolved) {
		t.Fatalf("expected ErrGateAlreadyResolved for a timed-out gate, got %v", err)
	}
}

func TestNewDecisionGate_RequiresOrchestrationTaskID(t *testing.T) {
	if _, err := NewDecisionGate("g1", "tenant-1", "", "d1", "proceed?", nil); !errors.Is(err, ErrEmptyOrchestrationTaskID) {
		t.Fatalf("expected ErrEmptyOrchestrationTaskID, got %v", err)
	}
}

func TestNewCoordinatorRun_ValidatesInvariantsAndDefaultsPollInterval(t *testing.T) {
	if _, err := NewCoordinatorRun("r1", "tenant-1", "", "coord-1", nil, 0); !errors.Is(err, ErrEmptyOriginTaskID) {
		t.Fatalf("expected ErrEmptyOriginTaskID, got %v", err)
	}
	if _, err := NewCoordinatorRun("r1", "tenant-1", "task-1", "", nil, 0); !errors.Is(err, ErrEmptyCoordinatorHandle) {
		t.Fatalf("expected ErrEmptyCoordinatorHandle, got %v", err)
	}

	run, err := NewCoordinatorRun("r1", "tenant-1", "task-1", "coord-1", nil, 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if run.Status != RunStatusIdle {
		t.Errorf("expected new run to start idle, got %s", run.Status)
	}
	if run.PollIntervalMs != defaultPollIntervalMs {
		t.Errorf("expected default poll interval %d, got %d", defaultPollIntervalMs, run.PollIntervalMs)
	}
}
