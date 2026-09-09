// Package config loads project-service's runtime configuration — env/flag
// parsing only, no business logic, per architecture/03-clean-architecture-guidelines.md.
package config

import (
	commonconfig "github.com/stablyai/orca-go/common/config"
)

type Config struct {
	commonconfig.Base
	// WorkflowServiceAddr and TaskServiceAddr are wired now even though
	// internal/adapter/grpcclient's checkers are currently STUBs (see that
	// package) — the config field shouldn't need to change when the real RPC
	// call is wired in.
	WorkflowServiceAddr string
	TaskServiceAddr     string
	// InfraFleetServiceAddr is ScanNested/ImportNested's/SetupExistingFolder's
	// DevServerRelay (and CreateHostSetup's DevServerLister) dependency.
	InfraFleetServiceAddr string
	// AuthServiceAddr is requireProjectAccess/requireRepoAccess's audit-append
	// dependency (TASK-BE-019/CR-RBAC-005, common/auditclient) — the only
	// other service this one talks to purely to write audit_log rows, never
	// to read anything back.
	AuthServiceAddr string
	// OPABundlePath points requireProjectAccess's OPA client
	// (internal/adapter/opaclient, via common/policy.Evaluator) at the
	// orca-authz Rego bundle directory. Defaults to the bundle's location
	// relative to this service's cmd/server working directory in local dev
	// (`go run ./cmd/server` from services/project-service) — same relative
	// path/env var name as auth-service/annotation-service/task-service's
	// own OPABundlePath, for identical override behavior in every
	// deployment environment.
	OPABundlePath string
	// DatabaseCredentialsFile is the path a Vault Agent sidecar renders
	// dynamic Postgres credentials to in production (see
	// common/secrets.DatabaseCredentialsFromFile). Falls back to DATABASE_DSN
	// (via Base) when the file doesn't exist, which is what local dev and
	// this scaffold's testcontainers path use instead.
	DatabaseCredentialsFile string
}

func Load() (Config, error) {
	base, err := commonconfig.LoadBase("project-service")
	if err != nil {
		return Config{}, err
	}
	return Config{
		Base:                    base,
		WorkflowServiceAddr:     commonconfig.StringEnv("WORKFLOW_SERVICE_ADDR", "workflow-service:9090"),
		TaskServiceAddr:         commonconfig.StringEnv("TASK_SERVICE_ADDR", "task-service:9090"),
		InfraFleetServiceAddr:   commonconfig.StringEnv("INFRA_FLEET_SERVICE_ADDR", "infra-fleet-service:9090"),
		AuthServiceAddr:         commonconfig.StringEnv("AUTH_SERVICE_ADDR", "auth-service:9090"),
		OPABundlePath:           commonconfig.StringEnv("OPA_BUNDLE_PATH", "/policy/orca-authz"),
		DatabaseCredentialsFile: commonconfig.StringEnv("DATABASE_CREDENTIALS_FILE", "/vault/secrets/database-credentials"),
	}, nil
}
