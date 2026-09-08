# TASK-FT-003-05: `task-service`'s `execution_links.status_mirror` consumer

**From Solution:** BE-SOL-003
**Priority:** P2
**Service:** `task-service`
**File:** `backend-go/services/task-service/internal/usecase/mirror_execution_status.go` (new), `backend-go/services/task-service/internal/usecase/ports.go` (`ExecutionLinkRepository.UpdateStatusMirror`), `backend-go/services/task-service/internal/adapter/eventbus/consumer.go` (new package), `backend-go/services/task-service/cmd/server/main.go` (wire consumer), `backend-go/services/task-service/internal/config/config.go` (new `NATSURL`)
**Depends on:** TASK-FT-001-03 (`execution_links` table/repository), TASK-FT-003-01/-02 (`orca.orchestration.task.statuschanged` publisher), TASK-FT-003-03 (`orca.workflow.step.completed` publisher)
**Status:** `[ ]` TODO

---

## Context

Per CR-FLOW-TASK-003, `task-service` subscribes
`orca.orchestration.task.statuschanged` and `orca.workflow.step.completed`
(ephemeral, same pattern as `notification-service`'s
`SubscribeEphemeral`-based `Consumer` at
`notification-service/internal/adapter/eventbus/consumer.go:77-98`,
confirmed real code) to update `execution_links.status_mirror`
(TASK-FT-001-01's table) — this is new plumbing, since `task-service` has
**no** `adapter/eventbus/` package at all today (confirmed: `find
services/task-service -iname "*eventbus*"` returns no results).

The consumer's handler is a small, single-purpose usecase, following the
exact idempotence posture SOL-TG-04's staleness guard already establishes
for this codebase's cross-service callback handlers: a status update for
an unknown `external_ref_id` is a no-op, not an error.

## Changes to make

**1. `ports.go`** — add to `ExecutionLinkRepository`
(TASK-FT-001-03's port):

```go
// UpdateStatusMirror updates the execution_links row whose external_ref_id
// matches ref — a no-op (not an error) if no such row exists, per this
// consumer's idempotence contract.
UpdateStatusMirror(ctx context.Context, tenantID, externalRefID, newStatus string) error
```

Implement it in `internal/adapter/postgres/execution_links.go`
(TASK-FT-001-03's file):

```go
func (r *Repository) UpdateStatusMirror(ctx context.Context, tenantID, externalRefID, newStatus string) error {
	_, err := r.pool.Exec(ctx, `
		UPDATE task.execution_links SET status_mirror = $1 WHERE external_ref_id = $2 AND tenant_id = $3
	`, newStatus, externalRefID, tenantID)
	if err != nil {
		return fmt.Errorf("postgres: update execution link status mirror: %w", err)
	}
	// Deliberately no RowsAffected() == 0 check here — unlike
	// SetExternalRef/Complete (which target a known link.ID this
	// service just created), a status_mirror update targets an
	// externalRefID this service does NOT own the lifecycle of; a
	// stale/duplicate/unrelated ref is a legitimate no-op, not an error.
	return nil
}
```

**2. New `internal/usecase/mirror_execution_status.go`:**

```go
package usecase

import "context"

type MirrorExecutionStatusInput struct {
	TenantID      string
	ExternalRefID string
	NewStatus     string
}

// MirrorExecutionStatus is the handler behind task-service's new
// orca.orchestration.task.statuschanged / orca.workflow.step.completed
// consumer (BE-SOL-003) — keeps execution_links.status_mirror
// (TASK-FT-001-01) roughly in sync with the owning engine's real state,
// for CR-FLOW-TASK-003's Activity Feed to read.
type MirrorExecutionStatus struct {
	links ExecutionLinkRepository
}

func NewMirrorExecutionStatus(links ExecutionLinkRepository) *MirrorExecutionStatus {
	return &MirrorExecutionStatus{links: links}
}

func (uc *MirrorExecutionStatus) Execute(ctx context.Context, in MirrorExecutionStatusInput) error {
	return uc.links.UpdateStatusMirror(ctx, in.TenantID, in.ExternalRefID, in.NewStatus)
}
```

**3. New `internal/adapter/eventbus/consumer.go`** — same shape as
`notification-service`'s consumer (`Subjects`/`Consumer`/`Run`,
`notification-service/internal/adapter/eventbus/consumer.go:30-99`,
confirmed real code), scoped to task-service's 2 subjects:

```go
package eventbus

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"

	commoneventbus "github.com/stablyai/orca-go/common/eventbus"
	"github.com/stablyai/orca-go/services/task-service/internal/usecase"
)

type SubjectBinding struct {
	StreamName string
	Subject    string
}

var Subjects = []SubjectBinding{
	{StreamName: "ORCHESTRATION", Subject: "orca.orchestration.task.statuschanged"},
	{StreamName: "WORKFLOW", Subject: "orca.workflow.step.completed"},
}

type Consumer struct {
	bus    *commoneventbus.Consumer
	mirror *usecase.MirrorExecutionStatus
}

func New(bus *commoneventbus.Consumer, mirror *usecase.MirrorExecutionStatus) *Consumer {
	return &Consumer{bus: bus, mirror: mirror}
}

func (c *Consumer) Run(ctx context.Context, logger *slog.Logger) {
	var wg sync.WaitGroup
	for _, binding := range Subjects {
		wg.Add(1)
		go func(b SubjectBinding) {
			defer wg.Done()
			err := c.bus.SubscribeEphemeral(ctx, b.StreamName, b.Subject, func(ctx context.Context, event commoneventbus.Event) error {
				var payload struct {
					ExternalRefID string `json:"execution_ref"` // confirm the real field name against TASK-FT-003-01/-02/-03's actual payload shapes — the orchestration.task.statuschanged and workflow.step.completed payloads may name this field differently (e.g. CoordinatorRunID/ExecutionID) per those tasks' own drafts; align on ONE field name across all three producing tasks before wiring this consumer
					Status        string `json:"status"`
				}
				if err := json.Unmarshal(event.Payload, &payload); err != nil {
					return err // unparseable payload — leave unacked for redelivery/investigation, matches notification-service's own posture
				}
				return c.mirror.Execute(ctx, usecase.MirrorExecutionStatusInput{
					TenantID: event.TenantID, ExternalRefID: payload.ExternalRefID, NewStatus: payload.Status,
				})
			})
			if err != nil {
				logger.WarnContext(ctx, "eventbus subject subscription ended",
					slog.String("stream", b.StreamName), slog.String("subject", b.Subject), slog.Any("error", err))
			}
		}(binding)
	}
	wg.Wait()
}
```

**Cross-task alignment needed**: this consumer's `payload.ExternalRefID`
field name must match whatever field name TASK-FT-003-01's
`TaskStatusChangedPayload` and TASK-FT-003-03's `stepEventPayload`
actually use for the orchestration task id / workflow execution id they
carry — confirm both payload shapes before finalizing this file's
`json:"..."` tags, rather than guessing a name independently here.

**4. `cmd/server/main.go`** — wire the consumer as a background goroutine,
same pattern `notification-service`'s `main.go` uses for its own
consumer:

```go
mirrorExecutionStatusUC := usecase.NewMirrorExecutionStatus(repo)
_, consumerBus, closeConsumerBus, err := commoneventbus.Connect(ctx, cfg.NATSURL)
if err != nil {
	logger.WarnContext(ctx, "eventbus unavailable, execution-status mirroring disabled", slog.Any("error", err))
} else {
	defer func() { _ = closeConsumerBus() }()
	consumer := taskeventbus.New(consumerBus, mirrorExecutionStatusUC)
	go consumer.Run(ctx, logger)
}
```

Add `NATSURL string` to `task-service`'s config if not already present
(confirmed absent today — this service has no NATS field at all, since it
has no eventbus package).

## Verify

```bash
cd /opt/repos/orca/backend-go
go build ./services/task-service/...
go test ./services/task-service/internal/usecase/... -run TestMirrorExecutionStatus -v
```

Expected: a status update for an unknown `external_ref_id` is a no-op,
not an error; a matching one updates `status_mirror` within the
bounded-poll window this codebase's other outbox-consumer tests already
use as the "not real-time, but bounded" precedent.
