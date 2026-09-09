// Package config loads task-service's runtime configuration — env/flag
// parsing only, no business logic, per architecture/03-clean-architecture-guidelines.md.
package config

import (
	commonconfig "github.com/stablyai/orca-go/common/config"
)

type Config struct {
	commonconfig.Base
	// OPABundlePath points ResolvePermission's OPA client
	// (internal/adapter/opaclient, via common/policy.Evaluator) at the
	// orca-authz Rego bundle on disk. Defaults to the bundle's location
	// relative to this service's module root when run the way this
	// service's README's "Running locally" section runs it (`cd
	// services/task-service && go run ./cmd/server`); override for
	// container images that lay the bundle out elsewhere.
	OPABundlePath string

	// InfraFleetServiceAddr is where SimpleExecutor/AIDecompose's real
	// (TASK-224) grpcclient adapters dial infra-fleet-service's
	// ResolveConnection and Relay RPCs.
	InfraFleetServiceAddr string
	// AIProviderServiceAddr is where AIDecompose's AIProviderContextResolver
	// dials ai-provider-service's ResolveProvider RPC.
	AIProviderServiceAddr string
	// AuthServiceAddr is ResolvePermission's audit-append dependency
	// (TASK-BE-020/CR-RBAC-005, common/auditclient) — the only other service
	// this one talks to purely to write audit_log rows.
	AuthServiceAddr string
}

func Load() (Config, error) {
	base, err := commonconfig.LoadBase("task-service")
	if err != nil {
		return Config{}, err
	}
	return Config{
		Base:                  base,
		OPABundlePath:         commonconfig.StringEnv("OPA_BUNDLE_PATH", "/policy/orca-authz"),
		InfraFleetServiceAddr: commonconfig.StringEnv("INFRA_FLEET_SERVICE_ADDR", "infra-fleet-service:9090"),
		AIProviderServiceAddr: commonconfig.StringEnv("AI_PROVIDER_SERVICE_ADDR", "ai-provider-service:9090"),
		AuthServiceAddr:       commonconfig.StringEnv("AUTH_SERVICE_ADDR", "auth-service:9090"),
	}, nil
}
