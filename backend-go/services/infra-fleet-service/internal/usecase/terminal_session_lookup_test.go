package usecase

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/stablyai/orca-go/services/infra-fleet-service/internal/domain"
)

// fakeTerminalSessionRepository is an in-memory TerminalSessionRepository —
// shared by every terminal usecase test (spawn/attach/wait/list/resize/
// kill/stop/focus/agentStatus/inspectProcess), same "test against fakes"
// convention as fakeConnectionResolver (see resolve_connection_test.go).
type fakeTerminalSessionRepository struct {
	mu sync.Mutex

	byPtyID map[string]domain.TerminalSession

	createErr   error
	getErr      error
	listErr     error
	touchErr    error
	closeErr    error
	closeAllErr error

	createCalls   []domain.TerminalSession
	touchCalls    []string
	closeCalls    []string
	closeAllCalls []string // connectionIDs CloseAllForConnection was called with
}

func (f *fakeTerminalSessionRepository) Create(ctx context.Context, session domain.TerminalSession) (domain.TerminalSession, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.createCalls = append(f.createCalls, session)
	if f.createErr != nil {
		return domain.TerminalSession{}, f.createErr
	}
	if f.byPtyID == nil {
		f.byPtyID = make(map[string]domain.TerminalSession)
	}
	f.byPtyID[session.PtyID] = session
	return session, nil
}

func (f *fakeTerminalSessionRepository) Get(ctx context.Context, tenantID, ptyID string) (bool, domain.TerminalSession, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.getErr != nil {
		return false, domain.TerminalSession{}, f.getErr
	}
	s, ok := f.byPtyID[ptyID]
	if !ok || s.TenantID != tenantID {
		return false, domain.TerminalSession{}, nil
	}
	return true, s, nil
}

func (f *fakeTerminalSessionRepository) List(ctx context.Context, tenantID, connectionID string) ([]domain.TerminalSession, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.listErr != nil {
		return nil, f.listErr
	}
	var out []domain.TerminalSession
	for _, s := range f.byPtyID {
		if s.TenantID != tenantID || s.ClosedAt != nil {
			continue
		}
		if connectionID != "" && s.ConnectionID != connectionID {
			continue
		}
		out = append(out, s)
	}
	return out, nil
}

func (f *fakeTerminalSessionRepository) Touch(ctx context.Context, tenantID, ptyID string, now time.Time) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.touchCalls = append(f.touchCalls, ptyID)
	if f.touchErr != nil {
		return f.touchErr
	}
	s, ok := f.byPtyID[ptyID]
	if !ok || s.TenantID != tenantID {
		return fmt.Errorf("fake: terminal session %q not found", ptyID)
	}
	s.LastActiveAt = now
	f.byPtyID[ptyID] = s
	return nil
}

func (f *fakeTerminalSessionRepository) Close(ctx context.Context, tenantID, ptyID string, closedAt time.Time) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.closeCalls = append(f.closeCalls, ptyID)
	if f.closeErr != nil {
		return f.closeErr
	}
	s, ok := f.byPtyID[ptyID]
	if !ok || s.TenantID != tenantID {
		return fmt.Errorf("fake: terminal session %q not found", ptyID)
	}
	t := closedAt
	s.ClosedAt = &t
	f.byPtyID[ptyID] = s
	return nil
}

// CloseAllForConnection implements usecase.TerminalSessionRepository.
// CloseAllForConnection — closes every open session bound to connectionID,
// mirroring the real store's WHERE connection_id = ... AND closed_at IS NULL.
func (f *fakeTerminalSessionRepository) CloseAllForConnection(ctx context.Context, tenantID, connectionID string, closedAt time.Time) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.closeAllCalls = append(f.closeAllCalls, connectionID)
	if f.closeAllErr != nil {
		return f.closeAllErr
	}
	for ptyID, s := range f.byPtyID {
		if s.TenantID != tenantID || s.ConnectionID != connectionID || s.ClosedAt != nil {
			continue
		}
		t := closedAt
		s.ClosedAt = &t
		f.byPtyID[ptyID] = s
	}
	return nil
}
