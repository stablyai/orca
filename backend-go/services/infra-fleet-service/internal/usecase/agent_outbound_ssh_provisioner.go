package usecase

import (
	"context"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/services/infra-fleet-service/internal/domain"
)

// ephemeralVmSshVaultMount/ephemeralVmSshVaultPath implement "Quyết định đã
// chốt" mục 2 (BE-SOL-EVM-004): a Vault KV v2 path DELIBERATELY separate
// from infra.ssh_targets' path family (that flow never uses KV at all — it
// uses the SSH secrets engine's ssh/sign/<role>, see
// sshconn.Connector.Connect and domain.SshTarget.VaultSSHRole). The path is
// deterministic BY RUNTIME ID, not derived from the recipe's raw
// identityFile/identityAgent string content — see
// AgentOutboundSshProvisioner's doc comment for why.
const ephemeralVmSshVaultMount = "secret"

func ephemeralVmSshVaultPath(runtimeID string) string {
	return "infra-fleet/ephemeral-vm-ssh-targets/" + runtimeID
}

// AgentOutboundSshProvisioner implements EphemeralVmSshProvisioner for
// EPHEMERAL_VM_SSH_MODE=agent-outbound (Hướng A, TASK-BE-EVM-014,
// BE-SOL-EVM-004 §2-3): resolves the hidden target's identity material from
// Vault, then hands it BY VALUE to the SAME Dev Server Agent that ran this
// runtime's vm.provision via a new RPC
// (DevServerAgentClient.DialHiddenSshTarget) — the agent itself dials
// outbound SSH (SOL-AG-EVM-003), never this backend.
//
// Vault resolution ("Quyết định đã chốt" mục 1-2): domain.EphemeralVmSshTarget
// arrives here with PrivateKeyPEM/IdentityAgentSocket populated VERBATIM
// from the recipe's raw identityFile/identityAgent strings —
// EphemeralVmRelay.buildEphemeralVmSshTarget's own doc comment flags this
// as a still-open "recipe string -> real credential" gap shared by every
// EphemeralVmSshProvisioner implementation, not invented by this type. This
// implementation treats a non-empty PrivateKeyPEM/IdentityAgentSocket as
// "this target has identity material to resolve", then fetches the REAL
// material from Vault at the deterministic per-runtime KV v2 path
// (ephemeralVmSshVaultPath) rather than trusting the recipe string's literal
// content as a path — an operator/ops-registration step (out of this task's
// scope, same as TASK-BE-EVM-012/013's identical gap for Hướng B) is
// expected to have written the real PEM/socket value there ahead of time,
// keyed by runtime_id.
//
// Resolved material lives only in the RAM of this one Provision call and
// the one DialHiddenSshTarget RPC frame — never written to Postgres (see
// TestAgentOutboundSshProvisioner_CredentialNeverPersisted). The audit row
// this type upserts into EphemeralVmSshTargetRepository carries only
// host/port/username/vault PATHS, never the resolved PEM/socket value
// itself.
//
// Known, documented gaps NOT closed by this pass — see
// specs/backend-go/crs/v3/ephemeral-vm/tasks/
// TASK-BE-EVM-014-agent-outbound-ssh-provisioner-backend.md's "Kết quả
// thực tế" for the full write-up:
//   - devServer resolution (EphemeralVmSshDevServerResolver's doc comment).
//   - connectionID returned: Provision returns runtimeID itself, NOT a
//     freshly-constructed infra.connections row — target carries no
//     ProjectRoot (buildEphemeralVmSshTarget drops
//     VmProvisionResult.ProjectRoot entirely), so a real domain.NewConnection
//     (which requires RepoPath) cannot be built from this method's inputs
//     alone. Per BE-SOL-EVM-004 §4's decision 3, ResolveConnection's target
//     for an ssh-type runtime stays the EXISTING Dev Server anyway
//     (hiddenTargetID is an orthogonal routing attribute, not a new
//     connections row) — this simplification does not block
//     TASK-BE-EVM-015's routing, but a literal infra.connections row for
//     this specific connectionID does not exist until a follow-up threads
//     ProjectRoot through EphemeralVmSshProvisioner.Provision's contract (a
//     signature change shared with Hướng B, out of this task's unilateral
//     authority).
type AgentOutboundSshProvisioner struct {
	agent      DevServerAgentClient
	devServers EphemeralVmSshDevServerResolver
	vault      EphemeralVmSshVaultResolver
	// records is optional (nil-safe) — a repository failure to persist the
	// audit row must never block the actual dial, which is the operation
	// that matters to the caller.
	records EphemeralVmSshTargetRepository
}

// NewAgentOutboundSshProvisioner builds an AgentOutboundSshProvisioner.
// records may be nil (audit-row persistence becomes a no-op) — every other
// argument is required.
func NewAgentOutboundSshProvisioner(agent DevServerAgentClient, devServers EphemeralVmSshDevServerResolver, vault EphemeralVmSshVaultResolver, records EphemeralVmSshTargetRepository) *AgentOutboundSshProvisioner {
	return &AgentOutboundSshProvisioner{agent: agent, devServers: devServers, vault: vault, records: records}
}

// compile-time interface satisfaction — TASK-BE-EVM-012's
// TestEphemeralVmSshProvisioner_InterfaceSatisfiedByBothImplementations.
var _ EphemeralVmSshProvisioner = (*AgentOutboundSshProvisioner)(nil)

// Provision implements EphemeralVmSshProvisioner — see this type's doc
// comment for the full resolve-then-dial flow and its known gaps.
func (p *AgentOutboundSshProvisioner) Provision(ctx context.Context, tenantID, runtimeID string, target domain.EphemeralVmSshTarget) (string, error) {
	resolved := target
	var identityFileVaultPath, identityAgentVaultPath string

	if target.PrivateKeyPEM != "" || target.IdentityAgentSocket != "" {
		vaultPath := ephemeralVmSshVaultPath(runtimeID)
		data, err := p.vault.KVRead(ctx, ephemeralVmSshVaultMount, vaultPath)
		if err != nil {
			return "", apperrors.New(apperrors.KindInternal, "INFRA_EPHEMERAL_VM_SSH_VAULT_RESOLVE_FAILED",
				"failed to resolve hidden ssh target credential material from vault", err)
		}

		if target.PrivateKeyPEM != "" {
			pem, _ := data["private_key_pem"].(string)
			if pem == "" {
				return "", apperrors.New(apperrors.KindFailedPrecondition, "INFRA_EPHEMERAL_VM_SSH_VAULT_MISSING_KEY",
					"vault has no private_key_pem registered at this hidden ssh target's path — see AgentOutboundSshProvisioner's doc comment", nil)
			}
			resolved.PrivateKeyPEM = pem
			identityFileVaultPath = vaultPath
		}
		if target.IdentityAgentSocket != "" {
			sock, _ := data["identity_agent_socket"].(string)
			if sock != "" {
				resolved.IdentityAgentSocket = sock
				identityAgentVaultPath = vaultPath
			}
		}
	}

	devServer, err := p.devServers.ResolveDevServer(ctx, tenantID, runtimeID)
	if err != nil {
		return "", apperrors.New(apperrors.KindFailedPrecondition, "INFRA_EPHEMERAL_VM_SSH_NO_DEV_SERVER",
			"no dev server agent session is known to dial this runtime's hidden ssh target — see EphemeralVmSshDevServerResolver's doc comment", err)
	}

	if _, err := p.agent.DialHiddenSshTarget(ctx, devServer, runtimeID, resolved); err != nil {
		return "", apperrors.New(apperrors.KindInternal, "INFRA_EPHEMERAL_VM_SSH_DIAL_FAILED",
			"failed to relay hidden ssh target dial to dev server agent", err)
	}

	if p.records != nil {
		_, _ = p.records.Upsert(ctx, domain.EphemeralVmSshTargetRecord{
			TenantID:               tenantID,
			RuntimeID:              runtimeID,
			Host:                   target.Host,
			Port:                   int32(target.Port),
			Username:               target.Username,
			IdentityFileVaultPath:  identityFileVaultPath,
			IdentityAgentVaultPath: identityAgentVaultPath,
		})
	}

	// hiddenTargetID == runtimeID by convention (BE-SOL-EVM-004 §4) — see
	// this type's doc comment for why this is not a real infra.connections
	// row.
	return runtimeID, nil
}
