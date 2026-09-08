package domain

import (
	"errors"
	"testing"
	"time"
)

// TestConnection_MarkDegraded_OnlyFromEstablished asserts MarkDegraded
// succeeds only from ConnectionStatusEstablished and rejects every other
// status — BE-SOL-STORAGE-003 §2's state machine allows no other edge into
// degraded.
func TestConnection_MarkDegraded_OnlyFromEstablished(t *testing.T) {
	now := time.Now()

	t.Run("from established succeeds", func(t *testing.T) {
		c := Connection{Status: ConnectionStatusEstablished, GracePeriodSeconds: 300}
		if err := c.MarkDegraded(now); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if c.Status != ConnectionStatusDegraded {
			t.Errorf("got status %q, want %q", c.Status, ConnectionStatusDegraded)
		}
		if c.DegradedSince == nil || !c.DegradedSince.Equal(now) {
			t.Errorf("expected DegradedSince to be set to now, got %v", c.DegradedSince)
		}
	})

	for _, status := range []string{ConnectionStatusEstablishing, ConnectionStatusDegraded, ConnectionStatusClosed, ""} {
		status := status
		t.Run("from "+status+" fails", func(t *testing.T) {
			c := Connection{Status: status, GracePeriodSeconds: 300}
			err := c.MarkDegraded(now)
			if err == nil {
				t.Fatalf("expected an error marking degraded from status %q", status)
			}
			if c.Status != status {
				t.Errorf("status must not change on failure: got %q, want unchanged %q", c.Status, status)
			}
			if c.DegradedSince != nil {
				t.Errorf("DegradedSince must not be set on failure, got %v", c.DegradedSince)
			}
		})
	}
}

// TestConnection_Reestablish_WithinGracePeriod_ReturnsToEstablished asserts
// a degraded connection reconnecting before its grace period elapses
// returns to established and REUSES the same connection (no new
// ID/DegradedSince left dangling).
func TestConnection_Reestablish_WithinGracePeriod_ReturnsToEstablished(t *testing.T) {
	degradedAt := time.Now().Add(-1 * time.Minute)
	c := Connection{
		ID:                 "conn-1",
		Status:             ConnectionStatusDegraded,
		DegradedSince:      &degradedAt,
		GracePeriodSeconds: 300, // 5 minutes; only 1 minute has elapsed
	}

	now := degradedAt.Add(2 * time.Minute) // still within the 300s grace period
	if err := c.Reestablish(now); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if c.Status != ConnectionStatusEstablished {
		t.Errorf("got status %q, want %q", c.Status, ConnectionStatusEstablished)
	}
	if c.DegradedSince != nil {
		t.Errorf("expected DegradedSince to be cleared, got %v", c.DegradedSince)
	}
	if c.ID != "conn-1" {
		t.Errorf("Reestablish must not change the connection's ID, got %q", c.ID)
	}
}

// TestConnection_Reestablish_AfterGracePeriodExpiry_ReturnsError asserts a
// reconnect attempt after the grace period has elapsed is rejected — the
// caller must call CloseAfterGracePeriodExpiry instead, never silently
// reopen a connection that already timed out.
func TestConnection_Reestablish_AfterGracePeriodExpiry_ReturnsError(t *testing.T) {
	degradedAt := time.Now().Add(-10 * time.Minute)
	c := Connection{
		ID:                 "conn-1",
		Status:             ConnectionStatusDegraded,
		DegradedSince:      &degradedAt,
		GracePeriodSeconds: 300, // 5 minutes; 10 minutes have elapsed
	}

	now := degradedAt.Add(10 * time.Minute)
	err := c.Reestablish(now)
	if !errors.Is(err, ErrGracePeriodExpired) {
		t.Fatalf("got error %v, want ErrGracePeriodExpired", err)
	}
	if c.Status != ConnectionStatusDegraded {
		t.Errorf("status must remain degraded on grace period expiry, got %q", c.Status)
	}
	if c.DegradedSince == nil {
		t.Errorf("DegradedSince must not be cleared on grace period expiry")
	}
}

// TestConnection_CloseExplicitly_BypassesGracePeriodFromAnyNonClosedStatus
// asserts CloseExplicitly (TeardownConnection's confirmed-logout path)
// always closes immediately regardless of status or how much of the grace
// period has (not) elapsed — BE-SOL-STORAGE-003 §5.
func TestConnection_CloseExplicitly_BypassesGracePeriodFromAnyNonClosedStatus(t *testing.T) {
	recentlyDegraded := time.Now().Add(-1 * time.Second) // grace period nowhere near expired

	cases := []struct {
		name string
		conn Connection
	}{
		{name: "establishing", conn: Connection{Status: ConnectionStatusEstablishing}},
		{name: "established", conn: Connection{Status: ConnectionStatusEstablished}},
		{
			name: "degraded, grace period far from expiring",
			conn: Connection{Status: ConnectionStatusDegraded, DegradedSince: &recentlyDegraded, GracePeriodSeconds: 300},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := tc.conn
			c.CloseExplicitly()
			if c.Status != ConnectionStatusClosed {
				t.Errorf("got status %q, want %q", c.Status, ConnectionStatusClosed)
			}
			if c.DegradedSince != nil {
				t.Errorf("expected DegradedSince to be cleared, got %v", c.DegradedSince)
			}
		})
	}

	// Idempotent from an already-closed status too.
	c := Connection{Status: ConnectionStatusClosed}
	c.CloseExplicitly()
	if c.Status != ConnectionStatusClosed {
		t.Errorf("got status %q, want %q", c.Status, ConnectionStatusClosed)
	}
}
