// Package config loads infra-fleet-service's runtime configuration —
// env/flag parsing only, no business logic, per
// architecture/03-clean-architecture-guidelines.md.
package config

import (
	"os"

	commonconfig "github.com/stablyai/orca-go/common/config"
)

// Config embeds commonconfig.Base plus ServerDeployment — the one
// service-specific setting TASK-185 (Terminal/PTY RPCs) adds: whether this
// deployment is running in server mode (multiple users/tenants against
// shared dev servers) vs. the desktop/Electron single-user mode. See
// usecase.SpawnTerminalSession's doc comment: SpawnTerminalSessionRequest's
// empty connection_id ("host-local") is rejected when ServerDeployment is
// true, per the proto's own doc comment on that field.
type Config struct {
	commonconfig.Base
	// ServerDeployment is read from ORCA_SERVER_DEPLOYMENT (default false —
	// local/desktop dev is the common case for running this service
	// standalone). Any value other than exactly "true" is treated as false,
	// fail-safe: an unrecognized value should not silently widen what
	// host-local terminal spawning is allowed.
	ServerDeployment bool
	// DatabaseCredentialsFile is the path a Vault Agent sidecar renders
	// dynamic Postgres credentials to in production (see
	// common/secrets.DatabaseCredentialsFromFile). Falls back to DATABASE_DSN
	// (via Base) when the file doesn't exist, which is what local dev and
	// this scaffold's testcontainers path use instead.
	DatabaseCredentialsFile string
	// NATSURL backs the transactional-outbox relay (common/outbox.Relay) —
	// see usage-service's identical field/usage for the pattern this mirrors.
	// Currently only used to publish orca.infrafleet.dev_server.disconnected
	// (see usecase.PollFleetHealth).
	NATSURL string
	// EphemeralVmSshMode selects which usecase.EphemeralVmSshProvisioner
	// implementation cmd/server/main.go wires for `ssh`-type ephemeral VM
	// recipe results (TASK-BE-EVM-012, BE-SOL-EVM-004 §5a): "agent-outbound"
	// (Hướng A, TASK-BE-EVM-014) or "backend-relay-deploy" (Hướng B,
	// TASK-BE-EVM-013). Any value other than exactly "agent-outbound" is
	// treated as "backend-relay-deploy" — fail-safe default, matching
	// ServerDeployment's "unrecognized value doesn't silently widen
	// behavior" convention just above, and because backend-relay-deploy
	// reuses the already-shipped sshrelay/sshconn pipeline (no new agent
	// capability required).
	EphemeralVmSshMode string
}

func Load() (Config, error) {
	base, err := commonconfig.LoadBase("infra-fleet-service")
	if err != nil {
		return Config{}, err
	}
	sshMode := os.Getenv("EPHEMERAL_VM_SSH_MODE")
	if sshMode != "agent-outbound" {
		sshMode = "backend-relay-deploy"
	}

	return Config{
		Base:                    base,
		ServerDeployment:        os.Getenv("ORCA_SERVER_DEPLOYMENT") == "true",
		DatabaseCredentialsFile: commonconfig.StringEnv("DATABASE_CREDENTIALS_FILE", "/vault/secrets/database-credentials"),
		NATSURL:                 commonconfig.StringEnv("NATS_URL", "nats://localhost:4222"),
		EphemeralVmSshMode:      sshMode,
	}, nil
}
