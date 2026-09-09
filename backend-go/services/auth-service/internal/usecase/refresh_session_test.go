package usecase

import (
	"context"
	"testing"
	"time"

	"github.com/stablyai/orca-go/services/auth-service/internal/domain"
)

func seedRefreshableSession(t *testing.T, sessions *fakeSessionRepository, rawToken, rawRefreshToken, userID, tenantID string, now time.Time) domain.Session {
	t.Helper()
	s := domain.Session{
		TokenHash:        domain.HashSessionToken(rawToken),
		UserID:           userID,
		TenantID:         tenantID,
		CreatedAt:        now,
		ExpiresAt:        now.Add(time.Hour),
		RefreshTokenHash: domain.HashSessionToken(rawRefreshToken),
		RefreshExpiresAt: now.Add(30 * 24 * time.Hour),
	}
	if err := sessions.CreateSession(context.Background(), s); err != nil {
		t.Fatalf("seeding session: %v", err)
	}
	return s
}

func TestRefreshSession_ValidRefreshRotatesAndReturnsNewSession(t *testing.T) {
	sessions := newFakeSessionRepository()
	now := time.Now()
	seedRefreshableSession(t, sessions, "old-session-token", "old-refresh-token", "u1", "t1", now)

	clock := &fakeClock{now: now.Add(time.Minute)}
	uc := NewRefreshSession(sessions, clock, time.Hour, 30*24*time.Hour)

	out, err := uc.Execute(context.Background(), RefreshSessionInput{RefreshToken: "old-refresh-token"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out.SessionToken == "" {
		t.Fatal("expected a new session token")
	}
	if out.SessionToken == "old-session-token" {
		t.Error("expected a NEW session token, got the old one back")
	}

	// Old session row must now be revoked.
	oldSession, err := sessions.GetSessionByTokenHash(context.Background(), domain.HashSessionToken("old-session-token"))
	if err != nil {
		t.Fatalf("expected old session row to still exist (revoked, not deleted): %v", err)
	}
	if oldSession.RevokedAt == nil {
		t.Error("expected old session to be revoked after rotation")
	}

	// New session row must exist, with its own distinct TokenHash and
	// RefreshTokenHash.
	newSession, err := sessions.GetSessionByTokenHash(context.Background(), domain.HashSessionToken(out.SessionToken))
	if err != nil {
		t.Fatalf("expected new session row to exist: %v", err)
	}
	if newSession.TokenHash == oldSession.TokenHash {
		t.Error("expected new session to have a different TokenHash")
	}
	if newSession.RefreshTokenHash == "" || newSession.RefreshTokenHash == oldSession.RefreshTokenHash {
		t.Error("expected new session to have a new, non-empty RefreshTokenHash")
	}
	if newSession.UserID != "u1" || newSession.TenantID != "t1" {
		t.Errorf("expected new session to carry over UserID/TenantID, got %+v", newSession)
	}
}

func TestRefreshSession_UnknownRefreshTokenIsRejected(t *testing.T) {
	sessions := newFakeSessionRepository()
	uc := NewRefreshSession(sessions, &fakeClock{now: time.Now()}, time.Hour, 30*24*time.Hour)

	if _, err := uc.Execute(context.Background(), RefreshSessionInput{RefreshToken: "never-issued"}); err == nil {
		t.Fatal("expected an error for an unknown refresh token")
	}
}

func TestRefreshSession_ExpiredRefreshTokenIsRejected(t *testing.T) {
	sessions := newFakeSessionRepository()
	now := time.Now()
	rawRefresh := "expiring-refresh-token"
	s := domain.Session{
		TokenHash:        domain.HashSessionToken("session-token"),
		UserID:           "u1",
		TenantID:         "t1",
		CreatedAt:        now.Add(-48 * time.Hour),
		ExpiresAt:        now.Add(-24 * time.Hour),
		RefreshTokenHash: domain.HashSessionToken(rawRefresh),
		RefreshExpiresAt: now.Add(-time.Minute), // already expired
	}
	if err := sessions.CreateSession(context.Background(), s); err != nil {
		t.Fatalf("seeding session: %v", err)
	}

	uc := NewRefreshSession(sessions, &fakeClock{now: now}, time.Hour, 30*24*time.Hour)
	if _, err := uc.Execute(context.Background(), RefreshSessionInput{RefreshToken: rawRefresh}); err == nil {
		t.Fatal("expected an error for an expired refresh token")
	}
}

func TestRefreshSession_RevokedRefreshTokenIsRejected(t *testing.T) {
	sessions := newFakeSessionRepository()
	now := time.Now()
	s := seedRefreshableSession(t, sessions, "session-token", "revoked-refresh-token", "u1", "t1", now)
	if err := sessions.RevokeSession(context.Background(), s.TokenHash, now); err != nil {
		t.Fatalf("revoking session: %v", err)
	}

	uc := NewRefreshSession(sessions, &fakeClock{now: now.Add(time.Minute)}, time.Hour, 30*24*time.Hour)
	if _, err := uc.Execute(context.Background(), RefreshSessionInput{RefreshToken: "revoked-refresh-token"}); err == nil {
		t.Fatal("expected an error for an already-revoked refresh token")
	}
}

// TestRefreshSession_ReuseOfRotatedAwayTokenRevokesWholeSession asserts the
// reuse-detection contract: presenting a refresh token that was already
// rotated away must revoke every session belonging to that user — not just
// deny this one request — per this usecase's doc comment.
func TestRefreshSession_ReuseOfRotatedAwayTokenRevokesWholeSession(t *testing.T) {
	sessions := newFakeSessionRepository()
	now := time.Now()
	seedRefreshableSession(t, sessions, "old-session-token", "stolen-refresh-token", "u1", "t1", now)

	// A second, unrelated, still-valid session for the SAME user (e.g. a
	// different device/browser) — must also get revoked once reuse is
	// detected.
	otherSession := domain.Session{
		TokenHash: domain.HashSessionToken("other-device-session-token"),
		UserID:    "u1",
		TenantID:  "t1",
		CreatedAt: now,
		ExpiresAt: now.Add(time.Hour),
	}
	if err := sessions.CreateSession(context.Background(), otherSession); err != nil {
		t.Fatalf("seeding other session: %v", err)
	}

	clock := &fakeClock{now: now.Add(time.Minute)}
	uc := NewRefreshSession(sessions, clock, time.Hour, 30*24*time.Hour)

	// First refresh: legitimate rotation.
	if _, err := uc.Execute(context.Background(), RefreshSessionInput{RefreshToken: "stolen-refresh-token"}); err != nil {
		t.Fatalf("unexpected error on first (legitimate) refresh: %v", err)
	}

	// Second refresh with the SAME (now rotated-away) refresh token —
	// reuse.
	if _, err := uc.Execute(context.Background(), RefreshSessionInput{RefreshToken: "stolen-refresh-token"}); err == nil {
		t.Fatal("expected an error when a rotated-away refresh token is reused")
	}

	// The unrelated other-device session must now be revoked too — proof
	// this was "revoke the whole session", not just a denial of this one
	// request.
	revokedOther, err := sessions.GetSessionByTokenHash(context.Background(), otherSession.TokenHash)
	if err != nil {
		t.Fatalf("expected other session row to still exist: %v", err)
	}
	if revokedOther.RevokedAt == nil {
		t.Error("expected reuse detection to revoke every session for the user, including unrelated ones")
	}
}
