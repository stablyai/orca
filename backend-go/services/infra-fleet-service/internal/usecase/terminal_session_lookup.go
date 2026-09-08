package usecase

import (
	"context"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/services/infra-fleet-service/internal/domain"
)

// resolveTerminalSession is the shared "which dev server owns this pty"
// lookup every control-plane terminal usecase needs (resize/kill/stop/wait/
// focus/agentStatus/inspectProcess): fetch the session row, then resolve its
// stored ConnectionID into a live DevServer. Kept as one function rather
// than duplicated per usecase, per this codebase's DRY convention for
// cross-cutting lookups (mirrors ScanWorkspacePorts/Relay's shared
// resolve-then-relay shape, generalized to sessions instead of a
// caller-supplied connectionId).
//
// ConnectionID falls back to a devServerId lookup when ResolveConnection
// finds no infra.connections row — same fallback as SpawnTerminalSession's
// own doc comment: a pre-project ephemeral terminal (CLI install,
// agent-skill setup) was spawned with a devServerId standing in for
// ConnectionID (no connections row exists for it), and every follow-up
// control-plane operation on that same session (resize on mount, kill,
// agent-status polling, ...) must resolve it the identical way or the
// terminal breaks one RPC after it successfully spawns. Found live
// 2026-08-30, the step right after the SpawnTerminalSession fix.
func resolveTerminalSession(ctx context.Context, tenantID, ptyID string, sessions TerminalSessionRepository, resolver ConnectionResolver, devServers DevServerRepository) (domain.TerminalSession, domain.DevServer, error) {
	found, session, err := sessions.Get(ctx, tenantID, ptyID)
	if err != nil {
		return domain.TerminalSession{}, domain.DevServer{}, apperrors.New(apperrors.KindInternal, "INFRA_TERMINAL_LOOKUP_FAILED", "failed to look up terminal session", err)
	}
	if !found {
		return domain.TerminalSession{}, domain.DevServer{}, apperrors.New(apperrors.KindNotFound, "INFRA_TERMINAL_NOT_FOUND", "terminal session not found", nil)
	}
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

	connected, devServer, _, err := resolver.ResolveConnection(ctx, tenantID, session.ConnectionID)
	if err != nil {
		return domain.TerminalSession{}, domain.DevServer{}, apperrors.New(apperrors.KindInternal, "INFRA_RESOLVE_FAILED", "failed to resolve connection", err)
	}
	if !connected {
		devServerByID, devErr := devServers.Get(ctx, tenantID, session.ConnectionID)
		if devErr != nil {
			return domain.TerminalSession{}, domain.DevServer{}, apperrors.New(apperrors.KindNotFound, "INFRA_CONNECTION_NOT_FOUND", "terminal session's connection is no longer bound to a dev server", nil)
		}
		devServer = devServerByID
	}
	return session, devServer, nil
}
