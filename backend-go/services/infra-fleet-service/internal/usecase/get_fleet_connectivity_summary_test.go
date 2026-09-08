package usecase

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stablyai/orca-go/services/infra-fleet-service/internal/domain"
)

// fakeFleetConnectivityRepository is an in-memory FleetConnectivityRepository.
type fakeFleetConnectivityRepository struct {
	byTenant map[string][]domain.Connection
	err      error
}

func (f *fakeFleetConnectivityRepository) ListConnectivitySummary(ctx context.Context, tenantID string) ([]domain.Connection, error) {
	if f.err != nil {
		return nil, f.err
	}
	return f.byTenant[tenantID], nil
}

func TestGetFleetConnectivitySummary_RequiresTenantContext(t *testing.T) {
	uc := NewGetFleetConnectivitySummary(&fakeFleetConnectivityRepository{})
	_, err := uc.Execute(context.Background())
	if err == nil {
		t.Fatal("expected an error when no tenant is in context")
	}
}

// TestGetFleetConnectivitySummary_ReturnsOnlyCallerTenantConnections is the
// tenant-isolation regression this RPC's security model depends on
// (BE-SOL-STORAGE-002 §5): 2 tenants each with their own connections, the
// caller must only ever see their own tenant's rows, never the other's,
// even though both are served by the same repository/usecase instance.
func TestGetFleetConnectivitySummary_ReturnsOnlyCallerTenantConnections(t *testing.T) {
	repo := &fakeFleetConnectivityRepository{byTenant: map[string][]domain.Connection{
		"tenant-1": {
			{ID: "conn-1", TenantID: "tenant-1", DevServerID: "ds-1", Status: domain.ConnectionStatusEstablished},
		},
		"tenant-2": {
			{ID: "conn-2", TenantID: "tenant-2", DevServerID: "ds-2", Status: domain.ConnectionStatusEstablished},
			{ID: "conn-3", TenantID: "tenant-2", DevServerID: "ds-3", Status: domain.ConnectionStatusDegraded},
		},
	}}
	uc := NewGetFleetConnectivitySummary(repo)

	// Tenant 1's caller sees only tenant 1's connection.
	out1, err := uc.Execute(withTenant(context.Background(), "tenant-1"))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(out1) != 1 || out1[0].ID != "conn-1" {
		t.Errorf("expected only tenant-1's connection, got %+v", out1)
	}
	for _, c := range out1 {
		if c.TenantID != "tenant-1" {
			t.Errorf("leaked a connection from another tenant: %+v", c)
		}
	}

	// Tenant 2's caller sees only tenant 2's connections, never tenant 1's.
	out2, err := uc.Execute(withTenant(context.Background(), "tenant-2"))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(out2) != 2 {
		t.Fatalf("expected 2 connections for tenant-2, got %d", len(out2))
	}
	for _, c := range out2 {
		if c.TenantID != "tenant-2" {
			t.Errorf("leaked a connection from another tenant: %+v", c)
		}
	}
}

// TestGetFleetConnectivitySummary_EmptyReturnsEmptyArrayNotNull follows the
// list-channel "[]-not-null" convention already established (BE-SOL-001):
// a tenant with zero connections gets an empty, non-nil slice back, not nil
// — callers must never need a nil-check before ranging/marshaling.
func TestGetFleetConnectivitySummary_EmptyReturnsEmptyArrayNotNull(t *testing.T) {
	repo := &fakeFleetConnectivityRepository{byTenant: map[string][]domain.Connection{}}
	uc := NewGetFleetConnectivitySummary(repo)

	out, err := uc.Execute(withTenant(context.Background(), "tenant-1"))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out == nil {
		t.Fatal("expected a non-nil empty slice, got nil")
	}
	if len(out) != 0 {
		t.Errorf("expected 0 connections, got %d", len(out))
	}
}

// TestGetFleetConnectivitySummary_DegradedSinceNullWhenNotDegraded asserts
// the passthrough is faithful: a connection that is NOT degraded carries a
// nil DegradedSince (the proto layer's toProtoConnectionHealthEntry maps
// this straight to an unset google.protobuf.Timestamp — see server.go),
// while a genuinely degraded connection's DegradedSince survives the round
// trip untouched.
func TestGetFleetConnectivitySummary_DegradedSinceNullWhenNotDegraded(t *testing.T) {
	degradedAt := time.Now().Add(-1 * time.Minute)
	repo := &fakeFleetConnectivityRepository{byTenant: map[string][]domain.Connection{
		"tenant-1": {
			{ID: "conn-1", TenantID: "tenant-1", DevServerID: "ds-1", Status: domain.ConnectionStatusEstablished, DegradedSince: nil},
			{ID: "conn-2", TenantID: "tenant-1", DevServerID: "ds-2", Status: domain.ConnectionStatusDegraded, DegradedSince: &degradedAt},
		},
	}}
	uc := NewGetFleetConnectivitySummary(repo)

	out, err := uc.Execute(withTenant(context.Background(), "tenant-1"))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(out) != 2 {
		t.Fatalf("expected 2 connections, got %d", len(out))
	}
	for _, c := range out {
		switch c.ID {
		case "conn-1":
			if c.DegradedSince != nil {
				t.Errorf("expected conn-1's DegradedSince to be nil (not degraded), got %v", c.DegradedSince)
			}
		case "conn-2":
			if c.DegradedSince == nil {
				t.Errorf("expected conn-2's DegradedSince to be set (degraded)")
			}
		}
	}
}

func TestGetFleetConnectivitySummary_RepositoryFailurePropagates(t *testing.T) {
	repo := &fakeFleetConnectivityRepository{err: errors.New("db unavailable")}
	uc := NewGetFleetConnectivitySummary(repo)

	_, err := uc.Execute(withTenant(context.Background(), "tenant-1"))
	if err == nil {
		t.Fatal("expected error to propagate from repository failure")
	}
}
