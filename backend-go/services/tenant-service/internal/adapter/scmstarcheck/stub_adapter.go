// Package scmstarcheck implements usecase.ScmStarCheckPort. StubAdapter is
// the only implementation until SOL-012 ships
// ScmIntegrationService.StarRepository — see TASK-013
// (specs/backend-go/bugs/missing-v3/tasks/) for the future real adapter
// this package will gain alongside this stub, wired by cmd/server/main.go's
// own decision of which to construct.
package scmstarcheck

import "context"

// StubAdapter always returns ok=false ("unable to determine/perform") — the
// same honest interim answer api-gateway's github.checkOrcaStarred channel
// already gives (channels_scm.go:56-70), not a fabricated result.
type StubAdapter struct{}

func NewStubAdapter() *StubAdapter { return &StubAdapter{} }

func (StubAdapter) CheckStarred(ctx context.Context, userID string) (bool, bool) {
	return false, false
}

func (StubAdapter) StarRepository(ctx context.Context, userID string) (bool, bool) {
	return false, false
}
