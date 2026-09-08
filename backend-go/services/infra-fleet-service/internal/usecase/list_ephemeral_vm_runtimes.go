package usecase

import (
	"context"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/common/tenant"
	"github.com/stablyai/orca-go/services/infra-fleet-service/internal/domain"
)

// EphemeralVmRuntimeRepository is TASK-002's read surface (List), extended
// by TASK-004 with GetByWorkspaceID/UpdateStatus for EphemeralVmRelay's
// write path, and by TASK-BE-EVM-001 with Get (by-id lookup) — needed by
// CleanupWorkspace, which only receives a runtimeID (not a workspaceID) and
// must load the runtime's RecipeID before relaying vm.exec.
type EphemeralVmRuntimeRepository interface {
	List(ctx context.Context, tenantID string) ([]domain.EphemeralVmRuntime, error)
	Get(ctx context.Context, tenantID, id string) (domain.EphemeralVmRuntime, error)
	GetByWorkspaceID(ctx context.Context, tenantID, workspaceID string) (domain.EphemeralVmRuntime, error)
	UpdateStatus(ctx context.Context, tenantID, id, status, workspaceID, lastError string) (domain.EphemeralVmRuntime, error)
	// UpdateProvisionResult sets status + connection_type together —
	// TASK-BE-EVM-004's EphemeralVmRelay.Provision needs to persist which
	// branch ("orca-server" | "ssh") vm.provision's terminal result
	// resolved to, which UpdateStatus alone cannot express (no
	// connection_type param on it — added as a separate method rather than
	// widening UpdateStatus's signature, which SuspendWorkspace/
	// ResumeWorkspace/CleanupWorkspace/AttachWorkspace already call with a
	// fixed 5-arg shape).
	UpdateProvisionResult(ctx context.Context, tenantID, id, status, connectionType, lastError string) (domain.EphemeralVmRuntime, error)
	// FindDevServerByEnvironmentID resolves an ephemeral VM's environmentId
	// alias to a dev_server_id — TASK-BE-EVM-007's SpawnTerminalSession
	// resolution fallback (BE-SOL-EVM-003 §2). environment_id IS the
	// dev_server_id verbatim (BE-SOL-EVM-003 §1's design: "environment_id
	// BẰNG LUÔN dev_server_id" — no separate translation table), so this
	// only needs to confirm a non-destroyed row exists for
	// (tenantID, environmentID) — found=false (not an error) when it
	// doesn't, matching Find*-style (not Get-style) repository methods
	// elsewhere in this codebase that distinguish "doesn't exist" from a
	// real failure without a sentinel error.
	FindDevServerByEnvironmentID(ctx context.Context, tenantID, environmentID string) (devServerID string, found bool, err error)
	// SetEnvironmentID writes the real dev_servers.id PK onto a runtime's
	// environment_id column — TASK-BE-EVM-011's decision: called from
	// agentwsserver.TokenIssuer.handlePost right after
	// ResolveDirectWebSocketDevServer resolves/creates the real dev_servers
	// row (NOT from EphemeralVmRelay.Provision's own "orca-server" result
	// handling — that event only carries a mobile-pairing pairingCode,
	// never a dev_server_id; see BE-SOL-EVM-003's "Quyết định đã chốt"
	// section for the full audit). runtimeID is the correlation key: the
	// caller passes the agent's self-declared external devServerID, which
	// only equals a real ephemeral_vm_runtimes.id when the recipe/VM's
	// agent process was launched with DEV_SERVER_ID=<runtimeID> (an
	// optional, opt-in recipe-author contract, not enforced). No matching
	// row (the common case — most agents are not ephemeral VMs) is not an
	// error the caller needs to branch on differently; see the postgres
	// implementation's doc comment for the exact not-found signal.
	SetEnvironmentID(ctx context.Context, tenantID, runtimeID, environmentID string) (domain.EphemeralVmRuntime, error)
}

// ListEphemeralVmRuntimes lists every non-destroyed ephemeral VM runtime for
// the caller's tenant — SOL-004 Group 1's second read.
type ListEphemeralVmRuntimes struct {
	runtimes EphemeralVmRuntimeRepository
}

func NewListEphemeralVmRuntimes(runtimes EphemeralVmRuntimeRepository) *ListEphemeralVmRuntimes {
	return &ListEphemeralVmRuntimes{runtimes: runtimes}
}

func (uc *ListEphemeralVmRuntimes) Execute(ctx context.Context) ([]domain.EphemeralVmRuntime, error) {
	tenantID, err := tenant.RequireTenantID(ctx)
	if err != nil {
		return nil, apperrors.New(apperrors.KindUnauthenticated, "INFRA_NO_TENANT", "no tenant in request context", err)
	}
	return uc.runtimes.List(ctx, tenantID)
}
