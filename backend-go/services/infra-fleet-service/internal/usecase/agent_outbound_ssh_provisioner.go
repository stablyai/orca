package usecase

import (
	"context"

	"github.com/google/uuid"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/services/infra-fleet-service/internal/domain"
)

// AgentOutboundSshProvisioner implements EphemeralVmSshProvisioner for
// EPHEMERAL_VM_SSH_MODE=agent-outbound (Hướng A, TASK-BE-EVM-014/016,
// BE-SOL-EVM-004 §2-3/§6a-§6b): hands sourceDevServer's agent the recipe's
// raw identity material (a filesystem PATH or ssh-agent socket PATH — never
// resolved bytes) via a new RPC (DevServerAgentClient.DialHiddenSshTarget)
// — the agent itself dials outbound SSH (SOL-AG-EVM-003), reading
// IdentityFilePath off its own disk. This backend never reads the file.
//
// GAP 1 FIX (TASK-BE-EVM-016, BE-SOL-EVM-004 §6a): TASK-BE-EVM-014's
// original version of this type resolved credential material from Vault
// before dialing — audited and found WRONG (see
// domain.EphemeralVmSshTarget's doc comment: identityFile is always a
// local path on the agent's own disk, never a Vault reference; nothing was
// ever written to the Vault path this used to read). That Vault-resolve
// step is deleted entirely — target.IdentityFilePath is forwarded to the
// agent byte-for-byte, exactly like IdentityAgentSocket already was.
//
// GAP 2 FIX (TASK-BE-EVM-016, BE-SOL-EVM-004 §6b): Provision now receives
// sourceDevServer directly (no more EphemeralVmSshDevServerResolver lookup
// port — EphemeralVmRelay.Provision already had this value) and
// target.ProjectRoot (from VmProvisionResult.ProjectRoot), enough to
// construct a REAL infra.connections row via domain.NewConnection — the
// returned connectionID now resolves through ResolveConnection like any
// other dev server, instead of being a bare runtimeID convention.
type AgentOutboundSshProvisioner struct {
	agent DevServerAgentClient
	conns ConnectionRepository
	// records is optional (nil-safe) — a repository failure to persist the
	// audit row must never block the actual dial, which is the operation
	// that matters to the caller.
	records EphemeralVmSshTargetRepository
}

// NewAgentOutboundSshProvisioner builds an AgentOutboundSshProvisioner.
// records may be nil (audit-row persistence becomes a no-op) — agent/conns
// are required.
func NewAgentOutboundSshProvisioner(agent DevServerAgentClient, conns ConnectionRepository, records EphemeralVmSshTargetRepository) *AgentOutboundSshProvisioner {
	return &AgentOutboundSshProvisioner{agent: agent, conns: conns, records: records}
}

// compile-time interface satisfaction — TASK-BE-EVM-012's
// TestEphemeralVmSshProvisioner_InterfaceSatisfiedByBothImplementations.
var _ EphemeralVmSshProvisioner = (*AgentOutboundSshProvisioner)(nil)

// Provision implements EphemeralVmSshProvisioner — see this type's doc
// comment for the Gap 1/2 fixes against TASK-BE-EVM-014's original version.
func (p *AgentOutboundSshProvisioner) Provision(ctx context.Context, tenantID, runtimeID string, sourceDevServer domain.DevServer, target domain.EphemeralVmSshTarget) (string, error) {
	// Gap 4 completion (found in final cross-check after TASK-BE-EVM-019):
	// read back any fingerprint a prior dial for this runtimeID recorded,
	// so the agent's TOFU check (TASK-AG-EVM-010) actually verifies on
	// repeat dials instead of always seeing "first use". A lookup failure
	// degrades to first-use (empty known fingerprint), same as p.records
	// being nil — persisting the audit trail must never block the dial
	// that actually matters to the caller.
	var previousFingerprint string
	if p.records != nil {
		if rec, found, err := p.records.Get(ctx, tenantID, runtimeID); err == nil && found {
			previousFingerprint = rec.HostKeyFingerprint
			target.KnownHostKeyFingerprint = previousFingerprint
		}
	}

	_, hostKeyFingerprint, err := p.agent.DialHiddenSshTarget(ctx, sourceDevServer, runtimeID, target)
	if err != nil {
		return "", apperrors.New(apperrors.KindInternal, "INFRA_EPHEMERAL_VM_SSH_DIAL_FAILED",
			"failed to relay hidden ssh target dial to dev server agent", err)
	}
	// Why fall back to previousFingerprint: Upsert below is a full
	// replace (ON CONFLICT DO UPDATE, not a partial merge) — an agent
	// build too old to echo hostKeyFingerprint back must never silently
	// erase a fingerprint a prior dial already recorded, or the NEXT
	// dial's TOFU check would wrongly see "first use" again.
	if hostKeyFingerprint == "" {
		hostKeyFingerprint = previousFingerprint
	}

	if p.records != nil {
		_, _ = p.records.Upsert(ctx, domain.EphemeralVmSshTargetRecord{
			TenantID:               tenantID,
			RuntimeID:              runtimeID,
			Host:                   target.Host,
			Port:                   int32(target.Port),
			Username:               target.Username,
			IdentityFileVaultPath:  target.IdentityFilePath,
			IdentityAgentVaultPath: target.IdentityAgentSocket,
			HostKeyFingerprint:     hostKeyFingerprint,
		})
	}

	conn, err := domain.NewConnection(uuid.NewString(), tenantID, sourceDevServer.ID, target.ProjectRoot, "")
	if err != nil {
		return "", apperrors.New(apperrors.KindInvalidArgument, "INFRA_EPHEMERAL_VM_SSH_INVALID_CONNECTION",
			"failed to construct a connection row for this hidden ssh target", err)
	}
	saved, err := p.conns.CreateConnection(ctx, conn)
	if err != nil {
		return "", apperrors.New(apperrors.KindInternal, "INFRA_EPHEMERAL_VM_SSH_CREATE_CONNECTION_FAILED",
			"failed to persist a connection row for this hidden ssh target", err)
	}

	return saved.ID, nil
}
