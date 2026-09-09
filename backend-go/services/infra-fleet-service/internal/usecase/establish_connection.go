package usecase

import (
	"context"

	"github.com/google/uuid"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/common/auditclient"
	"github.com/stablyai/orca-go/common/tenant"
	"github.com/stablyai/orca-go/services/infra-fleet-service/internal/domain"
)

// EstablishConnection performs the actual SSH + Dev Server Agent handshake
// synchronously — it is the connection-establishment act, not a record of
// one requested.
type EstablishConnection struct {
	sshTargets  SshTargetRepository
	devServers  DevServerRepository
	conns       ConnectionRepository
	agent       DevServerAgentClient
	auditClient *auditclient.Client
}

// NewEstablishConnection wires the single usecase that gates an actual
// SSH/PTY connect attempt (TASK-BE-022/CR-RBAC-005) — F32's own canonical
// audit example is "who connected to which server", ssh.connect.
// auditClient may be nil (e.g. existing unit tests that don't care about
// auditing) — see Execute's audit-append comment for the nil-safe,
// best-effort posture that matches.
func NewEstablishConnection(sshTargets SshTargetRepository, devServers DevServerRepository, conns ConnectionRepository, agent DevServerAgentClient, auditClient *auditclient.Client) *EstablishConnection {
	return &EstablishConnection{sshTargets: sshTargets, devServers: devServers, conns: conns, agent: agent, auditClient: auditClient}
}

type EstablishConnectionInput struct {
	SshTargetID string
}

func (uc *EstablishConnection) Execute(ctx context.Context, in EstablishConnectionInput) (domain.Connection, error) {
	tenantID, err := tenant.RequireTenantID(ctx)
	if err != nil {
		return domain.Connection{}, apperrors.New(apperrors.KindUnauthenticated, "INFRA_NO_TENANT", "no tenant in request context", err)
	}
	target, err := uc.sshTargets.Get(ctx, tenantID, in.SshTargetID)
	if err != nil {
		return domain.Connection{}, err
	}

	// Find-or-create the DevServer row this SSH target backs — an SSH
	// target only becomes routable once it's the ssh_target_id of a
	// relay-ssh-mode DevServer. ID generation happens here, not in
	// postgres/, matching register_dev_server.go's own convention.
	devServer, found, err := uc.devServers.FindBySshTarget(ctx, tenantID, target.ID)
	if err != nil {
		return domain.Connection{}, apperrors.New(apperrors.KindInternal, "INFRA_DEV_SERVER_RESOLVE_FAILED", "failed to resolve dev server for ssh target", err)
	}
	if !found {
		devServer, err = domain.NewDevServer(uuid.NewString(), tenantID, target.Host, domain.ConnectionModeRelaySSH, target.ID)
		if err != nil {
			return domain.Connection{}, apperrors.New(apperrors.KindInternal, "INFRA_DEV_SERVER_CONSTRUCT_FAILED", "failed to construct dev server for ssh target", err)
		}
		devServer, err = uc.devServers.Register(ctx, devServer)
		if err != nil {
			return domain.Connection{}, apperrors.New(apperrors.KindInternal, "INFRA_DEV_SERVER_REGISTER_FAILED", "failed to register dev server for ssh target", err)
		}
	}

	// The handshake itself — bootstrap/deploy is a separate concern if the
	// relay binary isn't deployed yet; Health() here confirms an
	// already-bootstrapped target is actually reachable before the
	// Connection is marked established. Per infra-fleet-service.md §8's
	// deadline rule, the caller (gRPC handler) carries an explicit timeout
	// longer than the intra-cluster default.
	reachable, healthErr := uc.agent.Health(ctx, devServer)
	allowed := healthErr == nil && reachable

	// Audit both the allow and deny outcome (F32's "ssh.connect" canonical
	// example, TASK-BE-022) — best-effort, never affects the decision
	// itself: Append is non-blocking (see auditclient.Client.Append's doc
	// comment), and a nil auditClient (not wired) is a no-op here too.
	if uc.auditClient != nil {
		actorID, _ := tenant.UserID(ctx)
		ip, _ := tenant.ClientIP(ctx)
		outcome := "denied"
		if allowed {
			outcome = "allowed"
		}
		uc.auditClient.Append(ctx, tenantID, actorID, "ssh.connect", "devserver:"+devServer.ID, outcome, ip)
	}

	if !allowed {
		return domain.Connection{}, apperrors.New(apperrors.KindFailedPrecondition, "INFRA_SSH_CONNECT_FAILED", "failed to establish SSH connection to target", healthErr)
	}

	conn, err := domain.NewConnection(uuid.NewString(), tenantID, devServer.ID, "", "")
	if err != nil {
		return domain.Connection{}, apperrors.New(apperrors.KindInternal, "INFRA_CONNECTION_CONSTRUCT_FAILED", "failed to construct connection", err)
	}
	conn.Status = "established"
	return uc.conns.CreateConnection(ctx, conn)
}
