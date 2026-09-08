package usecase

import (
	"context"
	"time"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/common/tenant"
	"github.com/stablyai/orca-go/services/infra-fleet-service/internal/domain"
)

// SpawnTerminalSessionInput mirrors the gRPC request 1:1 by design, see
// register_dev_server.go's comment for the rationale.
type SpawnTerminalSessionInput struct {
	ConnectionID string
	Cwd          string
	Shell        string
	Cols         int32
	Rows         int32
}

// SpawnTerminalSession creates a new PTY on the dev server ConnectionID
// resolves to (via pty.create, see DevServerAgentClient.SpawnPty) and
// persists the resulting session in TerminalSessionRepository — the write
// path every other terminal usecase's resolveTerminalSession lookup reads
// from.
//
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
//
// ConnectionID resolution falls back to treating it as a devServerId
// directly (via DevServerRepository) when ResolveConnection finds no
// infra.connections row — see the Execute body's own comment for why: a
// pre-project ephemeral terminal (CLI install, agent-skill setup) has no
// connections row to resolve, the same gap RelayByDevServer closes for Relay.
type SpawnTerminalSession struct {
	resolver            ConnectionResolver
	devServers          DevServerRepository
	agent               DevServerAgentClient
	sessions            TerminalSessionRepository
	ephemeralVmRuntimes EphemeralVmRuntimeRepository
	serverDeployment    bool
}

func NewSpawnTerminalSession(resolver ConnectionResolver, devServers DevServerRepository, agent DevServerAgentClient, sessions TerminalSessionRepository, ephemeralVmRuntimes EphemeralVmRuntimeRepository, serverDeployment bool) *SpawnTerminalSession {
	return &SpawnTerminalSession{resolver: resolver, devServers: devServers, agent: agent, sessions: sessions, ephemeralVmRuntimes: ephemeralVmRuntimes, serverDeployment: serverDeployment}
}

func (uc *SpawnTerminalSession) Execute(ctx context.Context, in SpawnTerminalSessionInput) (domain.TerminalSession, error) {
	tenantID, err := tenant.RequireTenantID(ctx)
	if err != nil {
		return domain.TerminalSession{}, apperrors.New(apperrors.KindUnauthenticated, "INFRA_NO_TENANT", "no tenant in request context", err)
	}

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

	connected, devServer, _, err := uc.resolver.ResolveConnection(ctx, tenantID, in.ConnectionID)
	if err != nil {
		return domain.TerminalSession{}, apperrors.New(apperrors.KindInternal, "INFRA_RESOLVE_FAILED", "failed to resolve connection", err)
	}
	if !connected {
		// Fallback: in.ConnectionID may actually be a devServerId, not an
		// infra.connections row id — pre-project ephemeral terminals (CLI
		// install, agent-skill setup) have no connections row to resolve
		// (no repo/worktree bound yet), the exact same chicken-and-egg gap
		// RelayByDevServer exists to close for Relay. Found live 2026-08-30:
		// api-gateway's terminal.create channel started passing a devServerId
		// straight through as connectionId for these terminals once they were
		// given a dev-server binding at all — try it directly before failing.
		devServerByID, devErr := uc.devServers.Get(ctx, tenantID, in.ConnectionID)
		if devErr != nil {
			// Second fallback: in.ConnectionID may actually be an ephemeral
			// VM's environmentId (TASK-BE-EVM-007, BE-SOL-EVM-003 §2) —
			// resolve via ephemeral_vm_runtimes.environment_id before giving
			// up. Same "no compute bound" error the empty-ConnectionID branch
			// above returns (not INFRA_CONNECTION_NOT_FOUND) — an
			// unresolvable environmentId is the same user-facing state as
			// never having provisioned one at all, per
			// TestSpawnTerminalSession_UnresolvableEnvironmentIdReturnsNoComputeBound's
			// contract: this must NOT regress dev servers'/SSH connections'
			// existing INFRA_CONNECTION_NOT_FOUND behavior when
			// ephemeralVmRuntimes finds nothing.
			devServerID, found, envErr := uc.ephemeralVmRuntimes.FindDevServerByEnvironmentID(ctx, tenantID, in.ConnectionID)
			if envErr != nil {
				return domain.TerminalSession{}, apperrors.New(apperrors.KindInternal, "INFRA_RESOLVE_FAILED", "failed to resolve environmentId", envErr)
			}
			if !found {
				return domain.TerminalSession{}, apperrors.New(apperrors.KindFailedPrecondition, "INFRA_TERMINAL_NO_COMPUTE_BOUND", "this environment has no dev server or SSH connection bound — attach compute before opening a terminal", nil)
			}
			devServerByID, devErr = uc.devServers.Get(ctx, tenantID, devServerID)
			if devErr != nil {
				return domain.TerminalSession{}, apperrors.New(apperrors.KindNotFound, "INFRA_CONNECTION_NOT_FOUND", "no dev server owns this connectionId", nil)
			}
		}
		if !uc.agent.IsConnected(devServerByID.ID) {
			return domain.TerminalSession{}, apperrors.New(apperrors.KindFailedPrecondition, "INFRA_DEV_SERVER_NOT_CONNECTED", "this dev server has no live agent connection right now", nil)
		}
		devServer = devServerByID
	}

	result, err := uc.agent.SpawnPty(ctx, devServer, SpawnPtyInput{Cwd: in.Cwd, Shell: in.Shell, Cols: in.Cols, Rows: in.Rows})
	if err != nil {
		return domain.TerminalSession{}, apperrors.New(apperrors.KindInternal, "INFRA_AGENT_SPAWN_PTY_FAILED", "failed to spawn pty on dev server agent", err)
	}
	if result.PtyID == "" {
		return domain.TerminalSession{}, apperrors.New(apperrors.KindInternal, "INFRA_AGENT_SPAWN_PTY_NO_ID", "dev server agent did not return a pty id", nil)
	}

	now := time.Now().UTC()
	cwd := result.Cwd
	if cwd == "" {
		cwd = in.Cwd
	}
	session, err := uc.sessions.Create(ctx, domain.TerminalSession{
		PtyID:        result.PtyID,
		TenantID:     tenantID,
		ConnectionID: in.ConnectionID,
		Cwd:          cwd,
		CreatedAt:    now,
		LastActiveAt: now,
	})
	if err != nil {
		return domain.TerminalSession{}, apperrors.New(apperrors.KindInternal, "INFRA_CREATE_TERMINAL_SESSION_FAILED", "failed to persist terminal session", err)
	}
	return session, nil
}
