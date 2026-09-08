package usecase

import (
	"context"
	"testing"

	"github.com/stablyai/orca-go/services/infra-fleet-service/internal/domain"
)

// fakeEphemeralVmRuntimeRepository is an in-memory EphemeralVmRuntimeRepository
// — shared by this file's ListEphemeralVmRuntimes tests and
// ephemeral_vm_relay_test.go's EphemeralVmRelay tests (TASK-004).
type fakeEphemeralVmRuntimeRepository struct {
	byTenant map[string][]domain.EphemeralVmRuntime
	listErr  error

	byID   map[string]domain.EphemeralVmRuntime
	getErr error

	byWorkspace       map[string]domain.EphemeralVmRuntime
	getByWorkspaceErr error

	updateStatusErr error
	// updateStatusCalls records every UpdateStatus invocation, in order —
	// TASK-004's regression test for AttachWorkspace's pure-bookkeeping
	// correction asserts against this rather than a single last-call field.
	updateStatusCalls []ephemeralVmUpdateStatusCall

	updateProvisionResultErr error
	// updateProvisionResultCalls mirrors updateStatusCalls's convention, for
	// TASK-BE-EVM-004's Provision.
	updateProvisionResultCalls []ephemeralVmUpdateProvisionResultCall

	// byEnvironmentID/findDevServerByEnvironmentIDErr back
	// FindDevServerByEnvironmentID — TASK-BE-EVM-007.
	byEnvironmentID                 map[string]string
	findDevServerByEnvironmentIDErr error

	// setEnvironmentIDErr/setEnvironmentIDCalls back SetEnvironmentID —
	// TASK-BE-EVM-011/006. Not called by any usecase in this package today
	// (the real caller is agentwsserver.TokenIssuer, a different package —
	// see BE-SOL-EVM-003's "Quyết định đã chốt" section); this fake only
	// needs to satisfy the interface for the other usecases sharing it
	// (EphemeralVmRelay, ListEphemeralVmRuntimes).
	setEnvironmentIDErr   error
	setEnvironmentIDCalls []ephemeralVmSetEnvironmentIDCall
}

type ephemeralVmSetEnvironmentIDCall struct {
	tenantID, runtimeID, environmentID string
}

type ephemeralVmUpdateStatusCall struct {
	tenantID, id, status, workspaceID, lastError string
}

type ephemeralVmUpdateProvisionResultCall struct {
	tenantID, id, status, connectionType, lastError string
}

func (f *fakeEphemeralVmRuntimeRepository) List(ctx context.Context, tenantID string) ([]domain.EphemeralVmRuntime, error) {
	if f.listErr != nil {
		return nil, f.listErr
	}
	return f.byTenant[tenantID], nil
}

func (f *fakeEphemeralVmRuntimeRepository) Get(ctx context.Context, tenantID, id string) (domain.EphemeralVmRuntime, error) {
	if f.getErr != nil {
		return domain.EphemeralVmRuntime{}, f.getErr
	}
	rt, ok := f.byID[id]
	if !ok {
		return domain.EphemeralVmRuntime{}, domain.ErrEphemeralVmRuntimeNotFound
	}
	return rt, nil
}

func (f *fakeEphemeralVmRuntimeRepository) GetByWorkspaceID(ctx context.Context, tenantID, workspaceID string) (domain.EphemeralVmRuntime, error) {
	if f.getByWorkspaceErr != nil {
		return domain.EphemeralVmRuntime{}, f.getByWorkspaceErr
	}
	rt, ok := f.byWorkspace[workspaceID]
	if !ok {
		return domain.EphemeralVmRuntime{}, domain.ErrEphemeralVmRuntimeNotFound
	}
	return rt, nil
}

func (f *fakeEphemeralVmRuntimeRepository) UpdateStatus(ctx context.Context, tenantID, id, status, workspaceID, lastError string) (domain.EphemeralVmRuntime, error) {
	f.updateStatusCalls = append(f.updateStatusCalls, ephemeralVmUpdateStatusCall{tenantID, id, status, workspaceID, lastError})
	if f.updateStatusErr != nil {
		return domain.EphemeralVmRuntime{}, f.updateStatusErr
	}
	return domain.EphemeralVmRuntime{ID: id, Status: status, WorkspaceID: workspaceID, LastError: lastError}, nil
}

func (f *fakeEphemeralVmRuntimeRepository) UpdateProvisionResult(ctx context.Context, tenantID, id, status, connectionType, lastError string) (domain.EphemeralVmRuntime, error) {
	f.updateProvisionResultCalls = append(f.updateProvisionResultCalls, ephemeralVmUpdateProvisionResultCall{tenantID, id, status, connectionType, lastError})
	if f.updateProvisionResultErr != nil {
		return domain.EphemeralVmRuntime{}, f.updateProvisionResultErr
	}
	return domain.EphemeralVmRuntime{ID: id, Status: status, ConnectionType: connectionType, LastError: lastError}, nil
}

func (f *fakeEphemeralVmRuntimeRepository) FindDevServerByEnvironmentID(ctx context.Context, tenantID, environmentID string) (string, bool, error) {
	if f.findDevServerByEnvironmentIDErr != nil {
		return "", false, f.findDevServerByEnvironmentIDErr
	}
	devServerID, ok := f.byEnvironmentID[environmentID]
	if !ok {
		return "", false, nil
	}
	return devServerID, true, nil
}

func (f *fakeEphemeralVmRuntimeRepository) SetEnvironmentID(ctx context.Context, tenantID, runtimeID, environmentID string) (domain.EphemeralVmRuntime, error) {
	f.setEnvironmentIDCalls = append(f.setEnvironmentIDCalls, ephemeralVmSetEnvironmentIDCall{tenantID, runtimeID, environmentID})
	if f.setEnvironmentIDErr != nil {
		return domain.EphemeralVmRuntime{}, f.setEnvironmentIDErr
	}
	rt, ok := f.byID[runtimeID]
	if !ok {
		return domain.EphemeralVmRuntime{}, domain.ErrEphemeralVmRuntimeNotFound
	}
	rt.EnvironmentID = environmentID
	return rt, nil
}

func TestListEphemeralVmRuntimes_RequiresTenantContext(t *testing.T) {
	uc := NewListEphemeralVmRuntimes(&fakeEphemeralVmRuntimeRepository{})
	_, err := uc.Execute(context.Background())
	if err == nil {
		t.Fatal("expected an error when no tenant is in context")
	}
}

func TestListEphemeralVmRuntimes_ReturnsRepoRowsForTenant(t *testing.T) {
	want := []domain.EphemeralVmRuntime{
		{ID: "rt-1", RepoID: "repo-1", RecipeID: "r1", Status: "active"},
	}
	repo := &fakeEphemeralVmRuntimeRepository{byTenant: map[string][]domain.EphemeralVmRuntime{"tenant-1": want}}
	uc := NewListEphemeralVmRuntimes(repo)

	ctx := withTenant(context.Background(), "tenant-1")
	got, err := uc.Execute(ctx)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 1 || got[0].ID != "rt-1" {
		t.Errorf("unexpected result: %+v", got)
	}
}
