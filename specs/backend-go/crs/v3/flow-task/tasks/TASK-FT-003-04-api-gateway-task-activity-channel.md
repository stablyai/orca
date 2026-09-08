# TASK-FT-003-04: `api-gateway`'s `task.activity` WS channel

**From Solution:** BE-SOL-003
**Priority:** P1
**Service:** `api-gateway`
**File:** `backend-go/services/api-gateway/internal/adapter/wscompat/channels_task_activity.go` (new), `backend-go/services/api-gateway/internal/adapter/wscompat/channels_task_activity_test.go` (new), `backend-go/services/api-gateway/cmd/server/main.go` (registration)
**Depends on:** TASK-FT-003-01, TASK-FT-003-02 (the 4 `orchestration.*` subjects), TASK-FT-003-03 (the 2 `workflow.step.*` subjects)
**Status:** `[ ]` TODO

---

## Context

**Grounding correction versus SOL-PW-04's own sketch, already identified
by BE-SOL-003 and confirmed here by reading the real code directly**:
SOL-PW-04 invents a `wsSessionRegistry`/`RegisterWorkspaceEventBridge`
pair from scratch. `api-gateway`'s `wscompat` layer has since gained a
real, working, general-purpose mechanism for exactly this shape of
problem — use it instead of duplicating:

- `StreamHandler` — `func(ctx context.Context, id Identity, args
  []json.RawMessage) (<-chan PushEvent, error)`
  (`push_bridge.go:12-19`, confirmed real, current code) and `PushEvent{
  Channel string, Args []any }` (`push_bridge.go:21-28`).
- `Registry.RegisterStream(channel string, h StreamHandler)` /
  `StreamHandlerFor(channel string) (StreamHandler, bool)`
  (`registry.go:104-114`, confirmed real, current methods).
- The real, shipped precedent using both:
  `registerNotificationStreamChannel` (`channels_push.go:45-65`, confirmed
  real).

`task.activity` differs from that precedent in one way: its source is not
one gRPC stream but multiple NATS subjects (the 4 `orchestration.*`
subjects from TASK-FT-003-01/-02, plus the 2 `workflow.step.*` subjects
from TASK-FT-003-03), filtered by `task_id` per connection — this task's
channel combines `RegisterStream` with a direct
`common/eventbus.Consumer.SubscribeEphemeral` per subject (the same
per-replica-fan-out mechanism `notification-service`'s own consumer uses,
confirmed real at
`notification-service/internal/adapter/eventbus/consumer.go:77-98`),
rather than introducing a third mechanism.

## Changes to make

```go
// backend-go/services/api-gateway/internal/adapter/wscompat/channels_task_activity.go (new)
package wscompat

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	commoneventbus "github.com/stablyai/orca-go/common/eventbus"
)

// TaskActivityFrame is task.activity.event's wire payload — one entry per
// orchestration/workflow-step event matching the subscribed taskId.
type TaskActivityFrame struct {
	TaskID     string          `json:"taskId"`
	Engine     string          `json:"engine"`     // "orchestration" | "workflow" (BE-SOL-001's domain.ExecutionEngine — direct_agent never appears here, it has no async event source)
	EventType  string          `json:"eventType"`  // "status_changed" | "message_posted" | "step_completed" | "step_failed" | "decision_gate_opened"
	Payload    json.RawMessage `json:"payload"`
	OccurredAt time.Time       `json:"occurredAt"`
}

type taskActivitySubject struct {
	StreamName string
	Subject    string
}

// taskActivitySubjects is the closed set of subjects this channel
// forwards — 4 orchestration.* (TASK-FT-003-01/-02) + 2 workflow.step.*
// (TASK-FT-003-03).
var taskActivitySubjects = []taskActivitySubject{
	{StreamName: "ORCHESTRATION", Subject: "orca.orchestration.task.dispatched"},
	{StreamName: "ORCHESTRATION", Subject: "orca.orchestration.task.statuschanged"},
	{StreamName: "ORCHESTRATION", Subject: "orca.orchestration.message.posted"},
	{StreamName: "ORCHESTRATION", Subject: "orca.orchestration.decision_gate.opened"},
	{StreamName: "WORKFLOW", Subject: "orca.workflow.step.completed"},
	{StreamName: "WORKFLOW", Subject: "orca.workflow.step.failed"},
}

// RegisterTaskActivityStreamChannel registers task.activity.subscribe —
// see this file's doc comment / BE-SOL-003's Context for why this
// combines RegisterStream with a direct per-subject SubscribeEphemeral
// rather than SOL-PW-04's from-scratch wsSessionRegistry sketch.
func RegisterTaskActivityStreamChannel(r *Registry, bus *commoneventbus.Consumer) {
	r.RegisterStream("task.activity.subscribe", func(ctx context.Context, id Identity, args []json.RawMessage) (<-chan PushEvent, error) {
		type subscribeArgs struct {
			TaskID string `json:"taskId"`
		}
		a, err := decodeArg[subscribeArgs](args, 0)
		if err != nil {
			return nil, err
		}
		if a.TaskID == "" {
			// wscompat's channels_*.go convention is plain fmt.Errorf, not
			// common/apperrors (that package's Kind/gRPC-status mapping is
			// for the gRPC-facing services this gateway calls into, not
			// this WS-facing layer itself — confirmed: no channels_*.go
			// file in this package imports apperrors).
			return nil, fmt.Errorf("task.activity.subscribe: taskId is required")
		}

		out := make(chan PushEvent)
		go func() {
			defer close(out)
			var wg sync.WaitGroup
			for _, sub := range taskActivitySubjects {
				sub := sub
				wg.Add(1)
				go func() {
					defer wg.Done()
					_ = bus.SubscribeEphemeral(ctx, sub.StreamName, sub.Subject, func(ctx context.Context, ev commoneventbus.Event) error {
						frame, ok := translateToTaskActivity(sub.Subject, ev, a.TaskID)
						if !ok {
							return nil
						}
						select {
						case out <- PushEvent{Channel: "task.activity.event", Args: []any{frame}}:
						case <-ctx.Done():
						}
						return nil
					})
				}()
			}
			wg.Wait()
		}()
		return out, nil
	})
}

// translateToTaskActivity decodes ev's payload and reports whether it
// matches taskID — filtering by task_id for direct orchestration events
// (they already carry orchestration_task_id, a task-service-external id
// per orchestration-service.md §2.1's distinct-id-space rule — resolve
// via the SAME origin_task_id field BE-SOL-002/BE-SOL-003 payloads carry,
// not the raw orchestration_task_id) and by origin_task_id for Engine 2/3
// events (orchestration_tasks.origin_task_id, already real; and
// workflow.executions.origin_task_id, BE-SOL-002's new column — both
// carried directly in each subject's outbox payload by TASK-FT-003-01/-02/-03,
// so this function does not need its own cross-service lookup).
func translateToTaskActivity(subject string, ev commoneventbus.Event, taskID string) (TaskActivityFrame, bool) {
	var origin struct {
		OriginTaskID string `json:"origin_task_id"`
	}
	if err := json.Unmarshal(ev.Payload, &origin); err != nil || origin.OriginTaskID != taskID {
		return TaskActivityFrame{}, false
	}
	engine, eventType := classifySubject(subject)
	return TaskActivityFrame{
		TaskID: taskID, Engine: engine, EventType: eventType,
		Payload: ev.Payload, OccurredAt: ev.OccurredAt,
	}, true
}

func classifySubject(subject string) (engine, eventType string) {
	switch subject {
	case "orca.orchestration.task.dispatched":
		return "orchestration", "status_changed"
	case "orca.orchestration.task.statuschanged":
		return "orchestration", "status_changed"
	case "orca.orchestration.message.posted":
		return "orchestration", "message_posted"
	case "orca.orchestration.decision_gate.opened":
		return "orchestration", "decision_gate_opened"
	case "orca.workflow.step.completed":
		return "workflow", "step_completed"
	case "orca.workflow.step.failed":
		return "workflow", "step_failed"
	default:
		return "", ""
	}
}
```

**Important, real gap this task must not paper over**: verify at
implementation time whether the 4 `orchestration.*` payloads
(`TASK-FT-003-01`/`-02`) actually carry an `origin_task_id` field.
Reading those tasks' payload sketches: `TaskStatusChangedPayload` carries
`OriginTaskID` (from `task.OriginTaskID`, confirmed present on
`domain.OrchestrationTask` per `orchestration-service.md:143`), but
`orca.orchestration.task.dispatched`'s and `.decision_gate.opened`'s
payloads as drafted in TASK-FT-003-01/-02 do **not** explicitly list an
`origin_task_id` field. Before writing this task's filter logic, confirm
every one of the 6 subjects' actual, final payload shape includes
`origin_task_id` (add it to any that don't, in the task that owns that
payload, rather than papering over a missing filter key here) — a channel
that silently matches zero events for a real subject is a worse failure
mode than a compile-time reminder to go fix the upstream payload.

Register in `cmd/server/main.go`, alongside the existing
`RegisterPushChannels` call:

```go
wscompat.RegisterTaskActivityStreamChannel(registry, natsConsumer)
```

## Verify

```bash
cd /opt/repos/orca/backend-go
go build ./services/api-gateway/...
go test ./services/api-gateway/internal/adapter/wscompat/... -run TestTaskActivity -v
```

Expected (fake `commoneventbus.Consumer`/`SubscribeEphemeral`): one
synthetic event per subject (6 total) reaches exactly one `PushEvent` on
a connection subscribed to the matching `taskId`; an event for a
different `taskId` reaches zero connections — per the CR's acceptance
criterion.
