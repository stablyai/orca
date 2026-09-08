# TASK-020: Apply the same `INFRA_TERMINAL_NO_COMPUTE_BOUND` rename to `resolveTerminalSession`'s guard

**From Solution:** SOL-008
**Priority:** P0 — ship-now fix, same rationale as TASK-019; land together for consistency (both are reached by the identical "host-local session" shape, from different call sites)
**Service:** `infra-fleet-service`
**File:** `backend-go/services/infra-fleet-service/internal/usecase/terminal_session_lookup.go`, `backend-go/services/infra-fleet-service/internal/usecase/resolve_terminal_session_test.go`
**Depends on:** none (parallel with TASK-019 — different function, same file family; no shared code)
**Status:** `[x]` DONE — implemented and verified as specified; the new empty-`ConnectionID` test returns before ever calling `resolver.ResolveConnection`/`devServers.Get`, so the fakes' zero-value behavior (checked in `register_dev_server_test.go`/`resolve_connection_test.go`) never came into play.

---

## Context

`resolveTerminalSession` is the shared lookup every other terminal
control-plane usecase (resize/kill/stop/wait/focus/agentStatus/
inspectProcess) calls to go from a `ptyId` to a live `DevServer`. Its
empty-`ConnectionID` guard currently returns
`INFRA_TERMINAL_HOST_LOCAL_UNSUPPORTED` — a second, differently-named
error for the exact same underlying condition TASK-019 renames in
`SpawnTerminalSession`. BUG-008 notes this is "not only a creation-time
gap, it's structural" (every control-plane op on a host-local-shaped
session hits it too), so SOL-008 gives it the identical treatment "for the
same reason: it's reached by resize/kill/focus/etc. on a session that
could only exist if creation had somehow produced one, so it should read
the same way to anyone debugging it."

## Changes to make

Current code (`terminal_session_lookup.go:36-42`):

```go
	if session.ConnectionID == "" {
		// Every session this service can currently spawn is connection-bound
		// (see SpawnTerminalSession's doc comment on host-local sessions not
		// being implemented) — an empty ConnectionID here would mean the row
		// is corrupt/from a future host-local code path this pass doesn't
		// support yet.
		return domain.TerminalSession{}, domain.DevServer{}, apperrors.New(apperrors.KindFailedPrecondition, "INFRA_TERMINAL_HOST_LOCAL_UNSUPPORTED", "terminal session has no connection_id — host-local sessions are not supported by this control-plane operation", nil)
	}
```

Replace with:

```go
	if session.ConnectionID == "" {
		// Same condition TASK-019 renames in SpawnTerminalSession, reached
		// from the other direction: a control-plane op (resize/kill/focus/
		// etc.) against a session row that has no connection_id at all.
		// Every session SpawnTerminalSession can currently create is
		// connection-bound (see spawn_terminal_session.go's doc comment), so
		// reaching this means either a corrupt row or a not-yet-existing
		// host-local code path — same INFRA_TERMINAL_NO_COMPUTE_BOUND code
		// as the creation-time guard so a caller doesn't need to special-case
		// two different names for the same underlying condition.
		return domain.TerminalSession{}, domain.DevServer{}, apperrors.New(apperrors.KindFailedPrecondition, "INFRA_TERMINAL_NO_COMPUTE_BOUND", "terminal session has no connection_id — host-local sessions are not supported by this control-plane operation", nil)
	}
```

### Test updates

No existing test in `resolve_terminal_session_test.go` exercises this
branch at all — both current tests
(`TestResolveTerminalSession_ConnectionIDIsActuallyADevServerID`,
`TestResolveTerminalSession_NeitherConnectionNorDevServerFound_ReturnsNotFound`)
set a non-empty `ConnectionID` on their fixture sessions. Add a new test
covering the empty-`ConnectionID` guard directly, since none exists to
rename:

```go
func TestResolveTerminalSession_EmptyConnectionID_ReturnsNoComputeBound(t *testing.T) {
	sessions := &fakeTerminalSessionRepository{
		byPtyID: map[string]domain.TerminalSession{
			"pty-1": {PtyID: "pty-1", TenantID: "tenant-1", ConnectionID: ""},
		},
	}
	resolver := &fakeConnectionResolver{byConnectionID: map[string]domain.DevServer{}}
	devServers := &fakeDevServerRepository{}

	_, _, err := resolveTerminalSession(withTenant(context.Background(), "tenant-1"), "tenant-1", "pty-1", sessions, resolver, devServers)
	var appErr *apperrors.AppError
	if !errors.As(err, &appErr) {
		t.Fatalf("expected an *apperrors.AppError, got %v", err)
	}
	if appErr.Code != "INFRA_TERMINAL_NO_COMPUTE_BOUND" {
		t.Errorf("expected code INFRA_TERMINAL_NO_COMPUTE_BOUND, got %q", appErr.Code)
	}
}
```

This needs the `apperrors` import added to
`resolve_terminal_session_test.go` (currently imports only `context`,
`errors`, `testing`, and the `domain` package):

```go
import (
	"context"
	"errors"
	"testing"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/services/infra-fleet-service/internal/domain"
)
```

Verify `fakeTerminalSessionRepository`/`fakeConnectionResolver`/
`fakeDevServerRepository`'s zero-value behavior matches what this test
needs (an empty `byConnectionID`/no `byID` entry so `ResolveConnection`
reports not-connected and the `devServers.Get` fallback also fails) —
these fakes are shared across `spawn_terminal_session_test.go` and this
file already, so check their zero-value `Get`/`ResolveConnection`
behavior before assuming this test compiles as written; adjust the fake
setup if a nil map read panics instead of returning "not found".

## Verify

```bash
cd backend-go
go build ./services/infra-fleet-service/...
go vet ./services/infra-fleet-service/...
go test ./services/infra-fleet-service/internal/usecase/... -run TestResolveTerminalSession -v
```

Expected: the new test passes, asserting `INFRA_TERMINAL_NO_COMPUTE_BOUND`;
the two existing `TestResolveTerminalSession_*` tests are unaffected (they
don't touch the empty-`ConnectionID` branch).
