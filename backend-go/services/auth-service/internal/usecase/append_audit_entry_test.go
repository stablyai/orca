package usecase

import (
	"context"
	"testing"
	"time"
)

// TestAppendAuditEntry_NoAdminGateRequired proves this usecase has no
// requireAdminActor-style check — a plain service-to-service caller (no
// admin, no actor identity resolved at all) succeeds, per this usecase's
// doc comment on why AppendAuditEntry differs from every other usecase in
// this package.
func TestAppendAuditEntry_NoAdminGateRequired(t *testing.T) {
	audit := &fakeAuditRepository{}
	uc := NewAppendAuditEntry(audit, &fakeClock{now: time.Unix(0, 0)})

	err := uc.Execute(context.Background(), AppendAuditEntryInput{
		TenantID: "t1",
		ActorID:  "u1",
		Action:   "project.update",
		Target:   "project:p1",
		Outcome:  "allowed",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(audit.entries) != 1 {
		t.Fatalf("expected 1 audit entry to be appended, got %d", len(audit.entries))
	}
	got := audit.entries[0]
	if got.TenantID != "t1" || got.ActorID != "u1" || got.Action != "project.update" || got.Target != "project:p1" {
		t.Errorf("unexpected entry: %+v", got)
	}
}

func TestAppendAuditEntry_RejectsEmptyTenantID(t *testing.T) {
	audit := &fakeAuditRepository{}
	uc := NewAppendAuditEntry(audit, &fakeClock{now: time.Unix(0, 0)})

	err := uc.Execute(context.Background(), AppendAuditEntryInput{Action: "project.update"})
	if err == nil {
		t.Fatal("expected an error for an empty tenant_id")
	}
	if len(audit.entries) != 0 {
		t.Errorf("expected no entry to be appended, got %d", len(audit.entries))
	}
}

func TestAppendAuditEntry_RejectsEmptyAction(t *testing.T) {
	audit := &fakeAuditRepository{}
	uc := NewAppendAuditEntry(audit, &fakeClock{now: time.Unix(0, 0)})

	err := uc.Execute(context.Background(), AppendAuditEntryInput{TenantID: "t1"})
	if err == nil {
		t.Fatal("expected an error for an empty action")
	}
	if len(audit.entries) != 0 {
		t.Errorf("expected no entry to be appended, got %d", len(audit.entries))
	}
}
