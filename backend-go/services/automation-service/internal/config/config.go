// Package config loads automation-service's runtime configuration —
// env/flag parsing only, no business logic, per
// architecture/03-clean-architecture-guidelines.md.
package config

import (
	"fmt"
	"os"
	"time"

	commonconfig "github.com/stablyai/orca-go/common/config"
)

// defaultSchedulerInterval matches automation-service.md §7's "~1 minute"
// in-process ticker loop guidance.
const defaultSchedulerInterval = time.Minute

// defaultSchedulerBatchSize caps how many due automations a single tick
// claims — an unbounded claim could hold the claim transaction (see
// internal/adapter/postgres's ClaimDue) open across an arbitrarily large
// number of workflow-service dispatch calls.
const defaultSchedulerBatchSize = 50

type Config struct {
	commonconfig.Base
	// WorkflowServiceAddr is the gRPC address of workflow-service, dialed by
	// internal/adapter/grpcclient's real WorkflowStepExecutor implementation
	// — the cross-service call RunNow exists to make, see
	// specs/backend-go/services/automation-service.md §2/§7.
	WorkflowServiceAddr string
	// ScmIntegrationServiceAddr is the gRPC address of scm-integration-service,
	// dialed by internal/adapter/grpcclient.ScmClient (usecase.PullRequestCreator)
	// — CR-AUTO-003/TASK-BE-AUTO-006, same dedicated-field convention as
	// WorkflowServiceAddr rather than api-gateway's OtherServiceAddrs map.
	ScmIntegrationServiceAddr string
	// SchedulerInterval is how often internal/adapter/scheduler's ticker
	// loop checks for due automations.
	SchedulerInterval time.Duration
	// SchedulerBatchSize is the max due automations claimed per tick.
	SchedulerBatchSize int32
}

func Load() (Config, error) {
	base, err := commonconfig.LoadBase("automation-service")
	if err != nil {
		return Config{}, err
	}
	interval, err := durationEnv("SCHEDULER_INTERVAL", defaultSchedulerInterval)
	if err != nil {
		return Config{}, err
	}
	batchSize, err := int32Env("SCHEDULER_BATCH_SIZE", defaultSchedulerBatchSize)
	if err != nil {
		return Config{}, err
	}
	return Config{
		Base:                base,
		WorkflowServiceAddr: commonconfig.StringEnv("WORKFLOW_SERVICE_ADDR", "localhost:9091"),
		// "localhost:9092" is a local-dev placeholder only (no docker-compose
		// entry or documented port for scm-integration-service exists yet to
		// confirm against) — every real deployment must set
		// SCM_INTEGRATION_SERVICE_ADDR explicitly, same as api-gateway's own
		// config does (no default there at all).
		ScmIntegrationServiceAddr: commonconfig.StringEnv("SCM_INTEGRATION_SERVICE_ADDR", "localhost:9092"),
		SchedulerInterval:         interval,
		SchedulerBatchSize:        batchSize,
	}, nil
}

// durationEnv and int32Env mirror common/config's unexported intEnv —
// kept local rather than promoted to common/config since this is currently
// the only service that needs a duration/int32 env var; promote later if a
// second service needs the same helpers.
func durationEnv(key string, def time.Duration) (time.Duration, error) {
	v := os.Getenv(key)
	if v == "" {
		return def, nil
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		return 0, fmt.Errorf("config: invalid duration for %s=%q: %w", key, v, err)
	}
	return d, nil
}

func int32Env(key string, def int32) (int32, error) {
	v := os.Getenv(key)
	if v == "" {
		return def, nil
	}
	var n int32
	if _, err := fmt.Sscanf(v, "%d", &n); err != nil {
		return 0, fmt.Errorf("config: invalid int for %s=%q: %w", key, v, err)
	}
	return n, nil
}
