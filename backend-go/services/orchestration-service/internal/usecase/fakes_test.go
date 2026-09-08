package usecase

import (
	"context"
	"sync"

	"github.com/stablyai/orca-go/services/orchestration-service/internal/domain"
)

// synchronousSerializer is the fake HandleSerializer suggested by
// orchestration-service.md §6: Do calls fn immediately, no goroutines
// needed to test usecase business logic. It also records the keys it was
// called with so tests can assert usecases key their serialized work
// correctly.
type synchronousSerializer struct {
	mu   sync.Mutex
	keys []string
}

func (s *synchronousSerializer) Do(_ context.Context, key string, fn func() error) error {
	s.mu.Lock()
	s.keys = append(s.keys, key)
	s.mu.Unlock()
	return fn()
}

func (s *synchronousSerializer) calledKeys() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]string, len(s.keys))
	copy(out, s.keys)
	return out
}

// fakeOrchestrationTaskRepository is an in-memory OrchestrationTaskRepository.
type fakeOrchestrationTaskRepository struct {
	tasks map[string]domain.OrchestrationTask
	err   error
}

func newFakeOrchestrationTaskRepository(tasks ...domain.OrchestrationTask) *fakeOrchestrationTaskRepository {
	m := make(map[string]domain.OrchestrationTask, len(tasks))
	for _, t := range tasks {
		m[t.ID] = t
	}
	return &fakeOrchestrationTaskRepository{tasks: m}
}

func (f *fakeOrchestrationTaskRepository) Create(_ context.Context, task domain.OrchestrationTask) (domain.OrchestrationTask, error) {
	if f.err != nil {
		return domain.OrchestrationTask{}, f.err
	}
	f.tasks[task.ID] = task
	return task, nil
}

func (f *fakeOrchestrationTaskRepository) Get(_ context.Context, _, id string) (domain.OrchestrationTask, error) {
	t, ok := f.tasks[id]
	if !ok {
		return domain.OrchestrationTask{}, ErrTaskNotFound
	}
	return t, nil
}

// UpdateStatusAndPromote mirrors the real Postgres transaction's semantics
// in memory: update the task, then promote any pending sibling whose deps
// are now all completed.
func (f *fakeOrchestrationTaskRepository) UpdateStatusAndPromote(_ context.Context, _, taskID string, newStatus domain.TaskStatus) (domain.OrchestrationTask, []string, error) {
	if f.err != nil {
		return domain.OrchestrationTask{}, nil, f.err
	}
	task, ok := f.tasks[taskID]
	if !ok {
		return domain.OrchestrationTask{}, nil, ErrTaskNotFound
	}
	task.Status = newStatus
	f.tasks[taskID] = task

	var promoted []string
	if newStatus == domain.TaskStatusCompleted {
		completed := map[string]struct{}{}
		for _, t := range f.tasks {
			if t.CoordinatorRunID == task.CoordinatorRunID && t.Status == domain.TaskStatusCompleted {
				completed[t.ID] = struct{}{}
			}
		}
		for id, t := range f.tasks {
			if t.CoordinatorRunID == task.CoordinatorRunID && t.Status == domain.TaskStatusPending && t.DepsSatisfied(completed) {
				t.Status = domain.TaskStatusReady
				f.tasks[id] = t
				promoted = append(promoted, id)
			}
		}
	}
	return task, promoted, nil
}

// fakeDispatchContextRepository is an in-memory DispatchContextRepository.
type fakeDispatchContextRepository struct {
	created []domain.DispatchContext
	err     error

	getLatestReturns domain.DispatchContext
	getLatestErr     error
	getLatestFunc    func(ctx context.Context, tenantID, taskID string) (domain.DispatchContext, error)

	listActiveErr  error
	listActiveFunc func(tenantID, userID string) ([]domain.DispatchContext, error)

	byID              map[string]domain.DispatchContext
	recordFailureErr  error
	recordFailureFunc func(tenantID, dispatchContextID, reason string) (domain.DispatchContext, error)
}

func (f *fakeDispatchContextRepository) CreateDispatchContext(_ context.Context, tenantID, userID, worktreeID, handle, coordinatorRunID, orchestrationTaskID string) (domain.DispatchContext, error) {
	if f.err != nil {
		return domain.DispatchContext{}, f.err
	}
	dc := domain.DispatchContext{
		ID:                  "dc-" + handle,
		TenantID:            tenantID,
		UserID:              userID,
		WorktreeID:          worktreeID,
		Handle:              handle,
		CoordinatorRunID:    coordinatorRunID,
		OrchestrationTaskID: orchestrationTaskID,
		Status:              domain.DispatchStatusPending,
	}
	f.created = append(f.created, dc)
	return dc, nil
}

func (f *fakeDispatchContextRepository) GetLatestForTask(ctx context.Context, tenantID, taskID string) (domain.DispatchContext, error) {
	if f.getLatestFunc != nil {
		return f.getLatestFunc(ctx, tenantID, taskID)
	}
	if f.getLatestErr != nil {
		return domain.DispatchContext{}, f.getLatestErr
	}
	return f.getLatestReturns, nil
}

func (f *fakeDispatchContextRepository) ListActiveDispatchContextsForUser(_ context.Context, tenantID, userID string) ([]domain.DispatchContext, error) {
	if f.listActiveErr != nil {
		return nil, f.listActiveErr
	}
	if f.listActiveFunc != nil {
		return f.listActiveFunc(tenantID, userID)
	}
	var out []domain.DispatchContext
	for _, dc := range f.created {
		if dc.TenantID == tenantID && dc.UserID == userID {
			out = append(out, dc)
		}
	}
	return out, nil
}

func (f *fakeDispatchContextRepository) RecordDispatchFailure(_ context.Context, tenantID, dispatchContextID, reason string) (domain.DispatchContext, error) {
	if f.recordFailureErr != nil {
		return domain.DispatchContext{}, f.recordFailureErr
	}
	if f.recordFailureFunc != nil {
		return f.recordFailureFunc(tenantID, dispatchContextID, reason)
	}
	dc, ok := f.byID[dispatchContextID]
	if !ok {
		return domain.DispatchContext{}, ErrDispatchContextNotFound
	}
	updated := dc.RecordFailure(reason)
	if f.byID == nil {
		f.byID = map[string]domain.DispatchContext{}
	}
	f.byID[dispatchContextID] = updated
	return updated, nil
}

// fakeGateRepository is an in-memory GateRepository.
type fakeGateRepository struct {
	gates map[string]domain.DecisionGate
	err   error
}

func newFakeGateRepository(gates ...domain.DecisionGate) *fakeGateRepository {
	m := make(map[string]domain.DecisionGate, len(gates))
	for _, g := range gates {
		m[g.ID] = g
	}
	return &fakeGateRepository{gates: m}
}

func (f *fakeGateRepository) CreateGate(_ context.Context, tenantID, dispatchContextID, question string, options []string) (domain.DecisionGate, error) {
	if f.err != nil {
		return domain.DecisionGate{}, f.err
	}
	g := domain.DecisionGate{
		ID:                  "gate-" + dispatchContextID,
		TenantID:            tenantID,
		OrchestrationTaskID: "task-for-" + dispatchContextID,
		DispatchContextID:   dispatchContextID,
		Question:            question,
		Options:             options,
		Status:              domain.GateStatusPending,
	}
	f.gates[g.ID] = g
	return g, nil
}

func (f *fakeGateRepository) ResolveGate(_ context.Context, _, gateID, resolution string) (domain.DecisionGate, []string, error) {
	if f.err != nil {
		return domain.DecisionGate{}, nil, f.err
	}
	g, ok := f.gates[gateID]
	if !ok {
		return domain.DecisionGate{}, nil, ErrGateNotFound
	}
	resolved, err := g.Resolve(resolution)
	if err != nil {
		return domain.DecisionGate{}, nil, ErrGateNotPending
	}
	f.gates[gateID] = resolved
	return resolved, []string{resolved.OrchestrationTaskID}, nil
}
