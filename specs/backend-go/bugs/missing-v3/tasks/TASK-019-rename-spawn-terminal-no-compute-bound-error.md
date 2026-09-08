# TASK-019: Rename `SpawnTerminalSession`'s empty-`ConnectionID` error to a stable `INFRA_TERMINAL_NO_COMPUTE_BOUND` code

**From Solution:** SOL-008
**Priority:** P0 — ship-now fix, no dependencies, unblocks TASK-021's frontend catch clause
**Service:** `infra-fleet-service`
**File:** `backend-go/services/infra-fleet-service/internal/usecase/spawn_terminal_session.go`, `backend-go/services/infra-fleet-service/internal/usecase/spawn_terminal_session_test.go`
**Depends on:** none
**Status:** `[x]` DONE — implemented and verified as specified (build/vet/test clean); also pinned `INFRA_TERMINAL_HOST_LOCAL_DISABLED` on the sibling test as the sketch prescribed.

---

## Context

BUG-008 traced that every real caller reaching `SpawnTerminalSession`'s
empty-`ConnectionID` branch outside server-deployment mode is a
`runtime:<environmentId>` target with no dev-server/SSH binding — never a
genuine "run this on my own desktop" request, since that request never
reaches backend-go's `terminal.create` at all (see SOL-008's frontend
trace, `pty-connection.ts:3118-3124`). Today that branch returns
`INFRA_TERMINAL_HOST_LOCAL_UNIMPLEMENTED`, which frames a permanent,
by-design architectural boundary (no local-pty adapter belongs in
backend-go, per `infra-fleet-service.md`'s Hard Boundary table) as if it
were a TODO. SOL-008 Part 1 renames this to a stable, precondition-shaped
code the frontend can recognize and turn into a recoverable state instead
of an opaque failure.

## Changes to make

Current code (`spawn_terminal_session.go:55-66`, `Execute`'s guard):

```go
func (uc *SpawnTerminalSession) Execute(ctx context.Context, in SpawnTerminalSessionInput) (domain.TerminalSession, error) {
	tenantID, err := tenant.RequireTenantID(ctx)
	if err != nil {
		return domain.TerminalSession{}, apperrors.New(apperrors.KindUnauthenticated, "INFRA_NO_TENANT", "no tenant in request context", err)
	}

	if in.ConnectionID == "" {
		if uc.serverDeployment {
			return domain.TerminalSession{}, apperrors.New(apperrors.KindFailedPrecondition, "INFRA_TERMINAL_HOST_LOCAL_DISABLED", "host-local terminal sessions are disabled in server-deployment mode", nil)
		}
		return domain.TerminalSession{}, apperrors.New(apperrors.KindFailedPrecondition, "INFRA_TERMINAL_HOST_LOCAL_UNIMPLEMENTED", "host-local terminal sessions are not implemented — every PTY this service can spawn today must go through a connectionId-bound dev server agent", nil)
	}
```

Replace the second branch only — **leave the server-deployment
`INFRA_TERMINAL_HOST_LOCAL_DISABLED` branch untouched**, per SOL-008's own
scoping ("keep the same error codes... only the sibling branch's code
changes"):

```go
	if in.ConnectionID == "" {
		if uc.serverDeployment {
			return domain.TerminalSession{}, apperrors.New(apperrors.KindFailedPrecondition, "INFRA_TERMINAL_HOST_LOCAL_DISABLED", "host-local terminal sessions are disabled in server-deployment mode", nil)
		}
		// Every real caller reaching this branch is a runtime:<environmentId>
		// target with no dev-server/SSH binding (see SOL-008's frontend
		// trace, specs/backend-go/bugs/missing-v3/solutions/SOL-008-*.md) —
		// never a genuine desktop-local request, which never reaches this
		// RPC. KindFailedPrecondition + a stable code the frontend can
		// switch on, so this renders as a fixable state ("bind a dev server
		// to this environment") rather than a bug report. Renamed from
		// INFRA_TERMINAL_HOST_LOCAL_UNIMPLEMENTED, which implied a TODO this
		// service will one day fix in-process — it will not (see the Hard
		// Boundary table this service's own package doc cites).
		return domain.TerminalSession{}, apperrors.New(apperrors.KindFailedPrecondition, "INFRA_TERMINAL_NO_COMPUTE_BOUND", "this environment has no dev server or SSH connection bound — attach compute before opening a terminal", nil)
	}
```

Also update the `Execute` doc comment above (`spawn_terminal_session.go:28-36`)
so it doesn't keep calling this "not implemented" now that the code name
says otherwise — the existing paragraph is accurate about the *mechanism*
(no local-pty adapter exists), it just needs the error-code reference
updated:

Current (lines 28-36):

```go
// Host-local sessions (ConnectionID == ""): the proto's doc comment says
// these are "rejected in server-deployment mode" — serverDeployment enforces
// exactly that. Outside server-deployment mode this service STILL cannot
// spawn a host-local PTY itself: there is no local-pty adapter in
// backend-go (PTYs only exist inside the agent's detached pty-daemon
// process, see adapter/devserveragent's package doc comment) — so a
// host-local request always fails today, with a distinct error explaining
// why, rather than silently no-opping. Tracked as a known gap, not
// implemented by this pass.
```

Replace the last sentence:

```go
// Host-local sessions (ConnectionID == ""): the proto's doc comment says
// these are "rejected in server-deployment mode" — serverDeployment enforces
// exactly that. Outside server-deployment mode this service STILL cannot
// spawn a host-local PTY itself: there is no local-pty adapter in
// backend-go (PTYs only exist inside the agent's detached pty-daemon
// process, see adapter/devserveragent's package doc comment), and per
// infra-fleet-service.md's Hard Boundary table, adding one is out of
// scope permanently, not a TODO — so this request fails with
// INFRA_TERMINAL_NO_COMPUTE_BOUND, a precondition the caller can fix by
// binding a dev server/SSH connection to the environment first (see
// SOL-008, specs/backend-go/bugs/missing-v3/), not a bug to fix here.
```

### Test updates

`spawn_terminal_session_test.go:28-35` currently only asserts an error was
returned, not which code:

```go
func TestSpawnTerminalSession_HostLocal_UnimplementedOutsideServerDeploymentMode(t *testing.T) {
	uc := NewSpawnTerminalSession(&fakeConnectionResolver{}, &fakeDevServerRepository{}, &fakeDevServerAgentClient{}, &fakeTerminalSessionRepository{}, false)
	ctx := withTenant(context.Background(), "tenant-1")
	_, err := uc.Execute(ctx, SpawnTerminalSessionInput{})
	if err == nil {
		t.Fatal("expected an error for a host-local spawn — no local pty adapter exists in this service")
	}
}
```

Rename it and assert the new code, so a future accidental revert is
caught:

```go
func TestSpawnTerminalSession_NoComputeBound_OutsideServerDeploymentMode(t *testing.T) {
	uc := NewSpawnTerminalSession(&fakeConnectionResolver{}, &fakeDevServerRepository{}, &fakeDevServerAgentClient{}, &fakeTerminalSessionRepository{}, false)
	ctx := withTenant(context.Background(), "tenant-1")
	_, err := uc.Execute(ctx, SpawnTerminalSessionInput{})
	var appErr *apperrors.AppError
	if !errors.As(err, &appErr) {
		t.Fatalf("expected an *apperrors.AppError, got %v", err)
	}
	if appErr.Code != "INFRA_TERMINAL_NO_COMPUTE_BOUND" {
		t.Errorf("expected code INFRA_TERMINAL_NO_COMPUTE_BOUND, got %q", appErr.Code)
	}
}
```

This needs two new imports in the test file (`errors` is already
imported; add `apperrors`):

```go
import (
	"context"
	"errors"
	"testing"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/services/infra-fleet-service/internal/domain"
)
```

Also add an equivalent code assertion to
`TestSpawnTerminalSession_HostLocal_RejectedInServerDeploymentMode`
(`spawn_terminal_session_test.go:19-26`) for `INFRA_TERMINAL_HOST_LOCAL_DISABLED`,
so both sibling branches are pinned the same way and a future change that
accidentally renames the untouched branch is also caught:

```go
func TestSpawnTerminalSession_HostLocal_RejectedInServerDeploymentMode(t *testing.T) {
	uc := NewSpawnTerminalSession(&fakeConnectionResolver{}, &fakeDevServerRepository{}, &fakeDevServerAgentClient{}, &fakeTerminalSessionRepository{}, true)
	ctx := withTenant(context.Background(), "tenant-1")
	_, err := uc.Execute(ctx, SpawnTerminalSessionInput{})
	var appErr *apperrors.AppError
	if !errors.As(err, &appErr) {
		t.Fatalf("expected an *apperrors.AppError, got %v", err)
	}
	if appErr.Code != "INFRA_TERMINAL_HOST_LOCAL_DISABLED" {
		t.Errorf("expected code INFRA_TERMINAL_HOST_LOCAL_DISABLED, got %q", appErr.Code)
	}
}
```

## Verify

```bash
cd backend-go
go build ./services/infra-fleet-service/...
go vet ./services/infra-fleet-service/...
go test ./services/infra-fleet-service/internal/usecase/... -run TestSpawnTerminalSession -v
```

Expected: both renamed/updated tests pass, asserting the exact codes; no
other `TestSpawnTerminalSession_*` test regresses (none of them touch the
empty-`ConnectionID` branch).
