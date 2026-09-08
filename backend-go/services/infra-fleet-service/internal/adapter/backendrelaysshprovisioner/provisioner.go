// Package backendrelaysshprovisioner implements usecase.EphemeralVmSshProvisioner
// for Hướng B ("backend-relay-deploy", TASK-BE-EVM-013, BE-SOL-EVM-004
// §5b-5d) — reusing adapter/sshrelay.Provisioner's already-shipped
// deploy(SFTP)+launch(SSH exec)+handshake pipeline verbatim, only swapping
// its auth for adapter/ephemeralsshconn's recipe-credential dial instead of
// adapter/sshconn's Vault-cert dial.
//
// Placed in internal/adapter/ (not internal/usecase/, as TASK-BE-EVM-013's
// own file list originally suggested) — a deliberate, audited deviation:
// this type's real dependencies (adapter/sshrelay.Provisioner,
// adapter/ephemeralsshconn.Connector, adapter/devserveragent.Client's
// AttachTransport, adapter/sshconn.Connection) are ALL adapter-layer types.
// Placing the struct in internal/usecase would require that package to
// import concrete adapter packages, which
// specs/backend-go/architecture/03-clean-architecture-guidelines.md's
// Dependency Inversion convention forbids (see usecase/ports.go's own doc
// comment: "the usecase layer must not depend on its concrete package").
// adapter/devserveragent already imports internal/usecase for this exact
// reason (implementing usecase.DevServerAgentClient with usecase-defined
// DTOs) — this package follows that same established precedent for
// implementing usecase.EphemeralVmSshProvisioner.
package backendrelaysshprovisioner

import (
	"context"
	"fmt"

	"github.com/stablyai/orca-go/services/infra-fleet-service/internal/adapter/devserveragent"
	"github.com/stablyai/orca-go/services/infra-fleet-service/internal/adapter/ephemeralsshconn"
	"github.com/stablyai/orca-go/services/infra-fleet-service/internal/adapter/sshrelay"
	"github.com/stablyai/orca-go/services/infra-fleet-service/internal/domain"
	"github.com/stablyai/orca-go/services/infra-fleet-service/internal/usecase"
)

// IDGenerator abstracts uuid.NewString for tests — mirrors
// usecase.NewCreateBrowserProfile's identical (browserProfileStore,
// uuid.NewString) convention in this same service.
type IDGenerator func() string

// Provisioner implements usecase.EphemeralVmSshProvisioner.
type Provisioner struct {
	devServers  usecase.DevServerRepository
	conns       usecase.ConnectionRepository
	runtimes    usecase.EphemeralVmRuntimeRepository
	agentClient *devserveragent.Client
	relayCfg    sshrelay.Config
	connCfg     ephemeralsshconn.Config
	newID       IDGenerator
	// sshTargets (TASK-BE-EVM-019, BE-SOL-EVM-004 §6d) is optional/nil-safe
	// (mirrors AgentOutboundSshProvisioner.records' convention) — backs
	// TOFU host-key verification's known/observed-fingerprint round-trip.
	// nil means "TOFU falls back to first-use-every-time" (never persists
	// a baseline — same as InsecureIgnoreHostKey's old behavior for
	// verification purposes, though the callback itself still runs).
	sshTargets usecase.EphemeralVmSshTargetRepository
}

// NewProvisioner builds a Provisioner. agentClient is the SAME
// *devserveragent.Client the rest of this service already shares (its
// AttachTransport method, not part of the narrower usecase.DevServerAgentClient
// port, is what registers the freshly dialed session for later Exec/Health
// calls — see that method's doc comment). relayCfg is typically the same
// sshrelay.LoadConfigFromEnv(...) value main.go already builds for the
// ordinary relay-ssh provisioner — this pipeline deploys the identical
// agent/out/agent.js bundle, just over a differently-authenticated
// connection. sshTargets may be nil (see that field's doc comment).
func NewProvisioner(devServers usecase.DevServerRepository, conns usecase.ConnectionRepository, runtimes usecase.EphemeralVmRuntimeRepository, agentClient *devserveragent.Client, relayCfg sshrelay.Config, connCfg ephemeralsshconn.Config, newID IDGenerator, sshTargets usecase.EphemeralVmSshTargetRepository) *Provisioner {
	return &Provisioner{
		devServers: devServers, conns: conns, runtimes: runtimes,
		agentClient: agentClient, relayCfg: relayCfg, connCfg: connCfg, newID: newID,
		sshTargets: sshTargets,
	}
}

var _ usecase.EphemeralVmSshProvisioner = (*Provisioner)(nil)

// Provision dials target (via a per-call adapter/ephemeralsshconn.Connector
// + SingleTargetResolver pair — see that package's doc comments for why a
// fresh, per-target instance is required rather than sharing one across
// calls), deploys+launches+handshakes over it (sshrelay.Provisioner,
// reused verbatim), registers the result as a normal dev_servers +
// connections row (mirrors usecase.EstablishConnection's registration
// shape, MINUS its find-or-create-by-ssh_target_id step — deliberately:
// every Provision call here represents a BRAND NEW ephemeral VM instance
// the recipe just created, never a previously-registered, reusable SSH
// target, so there is nothing to find), and sets environment_id=the new
// dev server's ID immediately (BE-SOL-EVM-004 §5c: "backend-go chính là
// bên khởi tạo kết nối, biết runtimeID từ đầu, không có độ trễ/sự kiện
// async tách biệt nào" — unlike TASK-BE-EVM-011's orca-server correlation,
// no polling/token-endpoint hook is needed).
//
// Credential material (target.PrivateKeyPEM/IdentityAgentSocket) never
// leaves this process: it's held only by the per-call
// ephemeralsshconn.Connector (dropped from memory right after Connect
// succeeds/fails — see that type's Connect doc comment) and is never
// logged or included in any error this method returns.
//
// sourceDevServer (TASK-BE-EVM-016's shared signature change, BE-SOL-EVM-004
// §6b/§6a, TASK-BE-EVM-017): the Dev Server whose agent ran this runtime's
// vm.provision `create` command — target.IdentityFilePath is a PATH on
// THAT agent's own disk (never a Vault pointer, see
// domain.EphemeralVmSshTarget's doc comment), and Hướng B dials
// off-machine, so it calls agentClient.ReadCredentialFile against
// sourceDevServer to resolve it into real PEM bytes BEFORE dialing.
// target.IdentityAgentSocket needs no such read — only the socket path
// itself travels, exactly like it always has.
func (p *Provisioner) Provision(ctx context.Context, tenantID, runtimeID string, sourceDevServer domain.DevServer, target domain.EphemeralVmSshTarget) (string, error) {
	if target.Host == "" {
		return "", fmt.Errorf("backendrelaysshprovisioner: ssh target has no host")
	}

	if target.IdentityFilePath != "" {
		contentPEM, err := p.agentClient.ReadCredentialFile(ctx, sourceDevServer, target.IdentityFilePath)
		if err != nil {
			return "", fmt.Errorf("backendrelaysshprovisioner: reading identity file from source dev server: %w", err)
		}
		target.PrivateKeyPEM = contentPEM
	}

	// TOFU host-key verification (TASK-BE-EVM-019, BE-SOL-EVM-004 §6d):
	// knownFingerprint stays "" (first-use, accept-and-record) when
	// sshTargets is nil or no prior successful dial was recorded for this
	// runtime — see ephemeralsshconn.Connector.NewConnector's doc comment.
	var knownFingerprint string
	if p.sshTargets != nil {
		if rec, found, err := p.sshTargets.Get(ctx, tenantID, runtimeID); err == nil && found {
			knownFingerprint = rec.HostKeyFingerprint
		}
	}

	connector := ephemeralsshconn.NewConnector(target, p.connCfg, knownFingerprint)
	resolver := ephemeralsshconn.SingleTargetResolver{
		Target: domain.SshTarget{
			ID: "ephemeral:" + runtimeID, TenantID: tenantID,
			Host: target.Host, UserName: target.Username,
		},
	}
	relayProvisioner := sshrelay.NewProvisioner(connector, resolver, p.relayCfg)

	// A placeholder, non-Postgres-backed ssh_target_id — domain.NewDevServer's
	// invariant only requires this to be non-empty for
	// ConnectionModeRelaySSH (see dev_server.go's ErrMissingSSHTargetForRelaySSH);
	// it is never looked up through usecase.SshTargetRepository for this
	// dev server, only through the per-call SingleTargetResolver above.
	devServer, err := domain.NewDevServer(p.newID(), tenantID, target.Host, domain.ConnectionModeRelaySSH, "ephemeral:"+runtimeID)
	if err != nil {
		return "", fmt.Errorf("backendrelaysshprovisioner: constructing dev server: %w", err)
	}

	transport, info, err := relayProvisioner.Provision(ctx, devServer)
	if err != nil {
		return "", fmt.Errorf("backendrelaysshprovisioner: provisioning runtime %s: %w", runtimeID, err)
	}

	// Connect succeeded (relayProvisioner.Provision cannot have without it),
	// so connector.ObservedFingerprint() is guaranteed non-empty here —
	// persist it as this runtime's TOFU baseline for the NEXT dial. A
	// repeat dial that already matched knownFingerprint re-writes the same
	// value (idempotent, harmless); a failed Upsert here must never fail
	// Provision itself (best-effort, same fail-open convention
	// AgentOutboundSshProvisioner's audit-row Upsert already uses) — a
	// dropped fingerprint write just means the NEXT dial falls back to
	// first-use again, not a security regression on THIS dial.
	if p.sshTargets != nil {
		_, _ = p.sshTargets.Upsert(ctx, domain.EphemeralVmSshTargetRecord{
			TenantID: tenantID, RuntimeID: runtimeID,
			Host: target.Host, Port: int32(target.Port), Username: target.Username,
			HostKeyFingerprint: connector.ObservedFingerprint(),
		})
	}

	saved, err := p.devServers.Register(ctx, devServer)
	if err != nil {
		_ = transport.Close("dev server registration failed")
		return "", fmt.Errorf("backendrelaysshprovisioner: registering dev server: %w", err)
	}

	// Attach the already-live session BEFORE returning — any Exec/Health
	// call that resolves this dev server after this point (including the
	// CreateConnection/SetEnvironmentID calls' own callers) must find a
	// live session, not have to re-provision.
	p.agentClient.AttachTransport(saved.ID, saved.Host, transport, info)

	conn, err := domain.NewConnection(p.newID(), tenantID, saved.ID, "", "")
	if err != nil {
		return "", fmt.Errorf("backendrelaysshprovisioner: constructing connection: %w", err)
	}
	conn.Status = domain.ConnectionStatusEstablished
	savedConn, err := p.conns.CreateConnection(ctx, conn)
	if err != nil {
		return "", fmt.Errorf("backendrelaysshprovisioner: creating connection: %w", err)
	}

	if _, err := p.runtimes.SetEnvironmentID(ctx, tenantID, runtimeID, saved.ID); err != nil {
		return "", fmt.Errorf("backendrelaysshprovisioner: setting environment_id: %w", err)
	}

	return savedConn.ID, nil
}
