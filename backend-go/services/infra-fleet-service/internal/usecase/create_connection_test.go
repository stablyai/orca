package usecase

import (
	"context"
	"errors"
	"testing"

	"github.com/stablyai/orca-go/services/infra-fleet-service/internal/domain"
)

// fakeConnectionRepository is an in-memory ConnectionRepository.
type fakeConnectionRepository struct {
	created []domain.Connection
	err     error

	// found/activeConn/activeErr drive GetActiveByDevServer's fake answer —
	// used by get_ssh_state_test.go.
	found      bool
	activeConn domain.Connection
	activeErr  error

	// updated/updateErr drive UpdateStatus's fake behavior — used by
	// poll_fleet_health_test.go's degraded/reestablish coverage.
	updated   []domain.Connection
	updateErr error
}

func (f *fakeConnectionRepository) CreateConnection(ctx context.Context, conn domain.Connection) (domain.Connection, error) {
	if f.err != nil {
		return domain.Connection{}, f.err
	}
	f.created = append(f.created, conn)
	return conn, nil
}

// GetActiveByDevServer implements usecase.ConnectionRepository.GetActiveByDevServer.
func (f *fakeConnectionRepository) GetActiveByDevServer(ctx context.Context, tenantID, devServerID string) (domain.Connection, bool, error) {
	if f.activeErr != nil {
		return domain.Connection{}, false, f.activeErr
	}
	if !f.found {
		return domain.Connection{}, false, nil
	}
	return f.activeConn, true, nil
}

// UpdateStatus implements usecase.ConnectionRepository.UpdateStatus.
func (f *fakeConnectionRepository) UpdateStatus(ctx context.Context, tenantID string, conn domain.Connection) error {
	if f.updateErr != nil {
		return f.updateErr
	}
	f.updated = append(f.updated, conn)
	f.activeConn = conn
	return nil
}

func TestCreateConnection_RequiresTenantContext(t *testing.T) {
	uc := NewCreateConnection(&fakeConnectionRepository{})
	_, err := uc.Execute(context.Background(), CreateConnectionInput{DevServerID: "ds1"})
	if err == nil {
		t.Fatal("expected an error when no tenant is in context")
	}
}

func TestCreateConnection_ValidatesInput(t *testing.T) {
	repo := &fakeConnectionRepository{}
	uc := NewCreateConnection(repo)

	ctx := withTenant(context.Background(), "tenant-1")
	_, err := uc.Execute(ctx, CreateConnectionInput{DevServerID: ""})
	if err == nil {
		t.Fatal("expected an error for an empty dev_server_id")
	}
	if len(repo.created) != 0 {
		t.Error("expected no connection to be created for invalid input")
	}
}

func TestCreateConnection_CreatesWithTenantFromContext(t *testing.T) {
	repo := &fakeConnectionRepository{}
	uc := NewCreateConnection(repo)

	ctx := withTenant(context.Background(), "tenant-1")
	got, err := uc.Execute(ctx, CreateConnectionInput{DevServerID: "ds1", RepoPath: "/repo", WorktreeID: "wt-1"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.TenantID != "tenant-1" {
		t.Errorf("expected tenant to come from context, got %q", got.TenantID)
	}
	if got.ID == "" {
		t.Error("expected a generated ID")
	}
	if got.RepoPath != "/repo" || got.WorktreeID != "wt-1" {
		t.Errorf("expected repo_path/worktree_id to round-trip, got %+v", got)
	}
	if len(repo.created) != 1 {
		t.Fatalf("expected 1 created connection, got %d", len(repo.created))
	}
}

func TestCreateConnection_RepositoryFailurePropagates(t *testing.T) {
	repo := &fakeConnectionRepository{err: errors.New("db unavailable")}
	uc := NewCreateConnection(repo)

	ctx := withTenant(context.Background(), "tenant-1")
	_, err := uc.Execute(ctx, CreateConnectionInput{DevServerID: "ds1"})
	if err == nil {
		t.Fatal("expected error to propagate from repository failure")
	}
}
