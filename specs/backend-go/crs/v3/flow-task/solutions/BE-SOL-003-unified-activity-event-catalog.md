# BE-SOL-003: `orchestration-service` outbox, `workflow-service` step events, and the `task.activity` WS channel

**Resolves:** [CR-FLOW-TASK-003](../../../../../docs/crs/v3/flow-task/CR-FLOW-TASK-003-unified-task-activity-event-catalog.md)
**Depends on:** [BE-SOL-002](./BE-SOL-002-workflow-as-execution-engine.md) (`origin_task_id` on `workflow.executions`), [SOL-PW-04](../../../../bugs/logic-v1/solutions/SOL-PW-04-workspace-integration-event-bus.md) (outbox pattern this solution extends, not replaces)
**Service:** `orchestration-service` (new outbox), `workflow-service` (new step-level events), `api-gateway` (new WS channel), `task-service` (new consumer)
**Affected files (proposed):**
- `backend-go/services/orchestration-service/internal/usecase/ports.go` (`OutboxStore`)
- `backend-go/services/orchestration-service/internal/adapter/postgres/` (new `outbox_events` table + enqueue)
- `backend-go/services/orchestration-service/migrations/0004_outbox_events.{up,down}.sql` (new)
- `backend-go/services/orchestration-service/internal/usecase/update_task_status_and_promote.go`, `create_dispatch_context.go`, `create_gate.go`, `resolve_gate.go`, `fail_dispatch.go` (each extended to enqueue)
- `backend-go/services/orchestration-service/cmd/server/main.go` (wire `outbox.Relay`)
- `backend-go/services/workflow-service/internal/usecase/wave_dispatcher.go` (step-level outbox enqueue)
- `backend-go/services/workflow-service/internal/adapter/eventbus/` (new — same shape SOL-PW-04 already proposed for this service)
- `backend-go/services/api-gateway/internal/adapter/wscompat/channels_task_activity.go` (new)
- `backend-go/services/task-service/internal/adapter/eventbus/` (new consumer)
**Status:** 📋 Proposed — not yet implemented

---

## Design rationale (grounded in TDD + real code, building on SOL-PW-04)

The CR is explicit that this is an extension, not a new mechanism
(`CR-FLOW-TASK-003.md:42`: "mẫu y hệt SOL-PW-04, áp dụng cho service thứ
ba"). Reading the real code confirms every gap the CR names:

- **`orchestration.messages` is real schema, zero RPC coverage** — the
  migration's own comment says so: "No RPC in the current generated
  proto... touches this table yet"
  (`services/orchestration-service/migrations/0001_init.up.sql:97-99`,
  confirmed by re-reading the file directly). `orchestration-service` has
  **no** `adapter/eventbus/` or `adapter/outbox`-shaped package today
  (confirmed: no such directory exists under
  `services/orchestration-service/internal/`), and its `main.go` wires
  only a gRPC listener and an HTTP health listener — no outbox relay
  (`cmd/server/main.go:88-124`, current, real).
- **`orca.orchestration.decision_gate.opened` is already wired on the
  *consuming* side** — `notification-service` already subscribes to it
  (`services/notification-service/internal/adapter/eventbus/consumer.go:50`:
  `{StreamName: "ORCHESTRATION", Subject: "orca.orchestration.decision_gate.opened"}`)
  and already has a translation for it
  (`services/notification-service/internal/domain/notification_event.go:121-122`:
  `Type: "decision_gate_opened", Title: "Needs your decision"`). This is
  exactly the CR's "dead subscription" finding
  (`CR-FLOW-TASK-003.md:60-63`) — the consumer and its translation exist
  and are tested; `orchestration-service` simply never publishes to that
  subject. This solution's job on the `orchestration-service` side is
  entirely publish-side.
- **A working outbox precedent already exists in this codebase** —
  `usage-service` (not `task-service`/`workflow-service`, which are still
  only *designed* per SOL-PW-04) has a real, shipped
  `usage.outbox_events` table (`services/usage-service/migrations/0002_outbox.up.sql`)
  and wires `common/outbox.NewRelay(repo, pub, outbox.DefaultConfig, logger)`
  in its `main.go` (confirmed: `grep -n "outbox\." services/usage-service/cmd/server/main.go`
  → line 109). This solution's `orchestration-service` outbox table is
  modeled directly on `usage.outbox_events`'s exact shape (`id`,
  `tenant_id`, `subject`, `occurred_at`, `version`, `payload`,
  `published_at`, plus the same partial `WHERE published_at IS NULL`
  index) rather than re-deriving a schema from `common/outbox.Store`'s
  interface alone — this is the concrete, already-running precedent
  `common/outbox/outbox.go`'s own doc comment says every service must
  supply for itself ("each service's own `internal/adapter/postgres`
  implements `Store` against its own outbox table").

## Design — `orchestration-service` outbox

### 1. Migration (additive, next free number — `0004`, after the real `0001`-`0003` that exist today)

```sql
-- backend-go/services/orchestration-service/migrations/0004_outbox_events.up.sql
-- Same shape as usage.outbox_events (services/usage-service/migrations/0002_outbox.up.sql),
-- the working precedent for common/outbox.Relay in this codebase.
CREATE TABLE orchestration.outbox_events (
    id            UUID PRIMARY KEY,
    tenant_id     UUID NOT NULL,
    subject       TEXT NOT NULL,
    occurred_at   TIMESTAMPTZ NOT NULL,
    version       INT NOT NULL,
    payload       JSONB NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at  TIMESTAMPTZ
);
CREATE INDEX idx_orchestration_outbox_events_unpublished
    ON orchestration.outbox_events (created_at)
    WHERE published_at IS NULL;
```

### 2. Port + enqueue call sites

```go
// internal/usecase/ports.go (new)
type OutboxStore interface {
	Enqueue(ctx context.Context, tx pgx.Tx, tenantID, subject string, payload any) error
}
```

Four subjects, per the CR (`CR-FLOW-TASK-003.md:56-63`), enqueued from the
usecases that already exist and already write the state each subject
reports on — no new usecase, only an additional `Enqueue` call inside each
one's existing transaction:

| Subject | Enqueued from (real, existing usecase) |
|---|---|
| `orca.orchestration.task.dispatched` | `create_dispatch_context.go` — the point a `dispatch_contexts` row is first created |
| `orca.orchestration.task.statuschanged` | `update_task_status_and_promote.go` — every `orchestration_tasks.status` write this usecase already makes |
| `orca.orchestration.message.posted` | **New write path, not just a new publish** — see below |
| `orca.orchestration.decision_gate.opened` | `create_gate.go` — the point a `decision_gates` row transitions the owning task to `blocked` |

`orca.orchestration.message.posted` is the one subject with no existing
write path to hook: the CR's own framing ("bảng chết — CR này là lý do đầu
tiên khiến bảng cần được ghi thật," `CR-FLOW-TASK-003.md:51-52`) means this
solution must also add the first real write to `orchestration.messages` —
out of scope for this CR to design as a full mailbox RPC surface (that is
`BUG-TASKV1-005`'s `PostMessage`/`ListMessages`/`RecordHeartbeat` gap,
tracked separately), so this solution's minimal scope is: `create_gate.go`
and `resolve_gate.go` each insert one `orchestration.messages` row of type
`decision_gate` in the same transaction as their existing write, purely so
the outbox has a real row to enqueue from — **not** a general-purpose
`PostMessage` usecase. If `BUG-TASKV1-005`'s autonomous-coordinator work
lands first, its `PostMessage` usecase becomes this subject's real writer
instead, and this solution's minimal insert is superseded, not duplicated.

```go
// update_task_status_and_promote.go — additive, inside the existing transaction
if err := uc.outbox.Enqueue(ctx, tx, tenantID, "orca.orchestration.task.statuschanged", TaskStatusChangedPayload{
	OrchestrationTaskID: task.ID, CoordinatorRunID: task.CoordinatorRunID,
	OriginTaskID: task.OriginTaskID, PreviousStatus: prevStatus, NewStatus: task.Status,
}); err != nil {
	return err
}
```

`main.go` wires `outbox.NewRelay(repo, pub, outbox.DefaultConfig, logger)`
the same way `usage-service/cmd/server/main.go:109` already does — this is
a copy of a working pattern, not a new one.

## Design — `workflow-service` step-level events

`wave_dispatcher.go`'s `dispatchStep` (`internal/usecase/wave_dispatcher.go:172-195`,
current, real) already calls `d.stepExecutions.UpdateStepExecution(ctx, se)`
twice — once optimistically before running the step (line 174), once with
the final result after (line 183). The second call site is where this
solution adds the enqueue, in the same transaction `UpdateStepExecution`'s
real implementation opens:

```go
// wave_dispatcher.go's dispatchStep, after the terminal UpdateStepExecution call
subject := "orca.workflow.step.completed"
if se.Status == domain.StepStatusFailed {
	subject = "orca.workflow.step.failed"
}
_ = d.outbox.Enqueue(ctx, tx, tenantID, subject, StepEventPayload{
	ExecutionID: executionID, StepID: se.StepID, StepType: step.Type,
	Status: string(se.Status), OriginTaskID: exec.OriginTaskID, // BE-SOL-002's new field
})
```

This needs `workflow-service` to gain the same `adapter/eventbus`/outbox
plumbing SOL-PW-04 already designed for its execution-level events
(`SOL-PW-04-workspace-integration-event-bus.md`'s "Design —
`workflow-service` usecase/adapter layer" section) — this solution adds
the step-level subject to that same, still-unimplemented plumbing rather
than inventing a second outbox mechanism for one service. If SOL-PW-04 is
implemented first, this solution's two subjects are added to its existing
`Enqueue` call site inside `wave_dispatcher.go`; if this solution is
implemented first, SOL-PW-04's execution-level subjects are added
alongside these at the same `internal/adapter/eventbus/` package this
solution creates. Either order works because both write to the same
transaction boundary (`dispatchStep`'s `UpdateStepExecution` call).

## Design — `api-gateway`'s `task.activity` WS channel

**Grounding correction versus SOL-PW-04's sketch**: SOL-PW-04's own design
invents a `wsSessionRegistry`/`RegisterWorkspaceEventBridge` pair from
scratch (`SOL-PW-04-workspace-integration-event-bus.md`'s "api-gateway:
two new pieces" section) — reasonable at the time it was written, but
`api-gateway`'s wscompat layer has since gained a real, working,
general-purpose mechanism for exactly this shape of problem that this
solution should build on instead of duplicating:

- `StreamHandler`/`PushEvent` (`services/api-gateway/internal/adapter/wscompat/push_bridge.go:12-28`)
  — a channel that opens a subscription and streams `PushEvent{Channel,
  Args}` frames to the client until the connection or subscription ends.
- `Registry.RegisterStream`/`StreamHandlerFor`
  (`services/api-gateway/internal/adapter/wscompat/registry.go:104-114`) —
  the registration point.
- The real, shipped precedent using both:
  `registerNotificationStreamChannel` (`channels_push.go:45-65`) opens a
  server-streaming gRPC call and forwards each item as one `PushEvent`.

`task.activity` differs from that precedent in one way: its source is not
one gRPC stream but multiple NATS subjects (the four `orchestration.*`
subjects above, plus `workflow.step.*`), filtered by `task_id` per
connection — closer to `ClientEventBus`'s in-process pub-sub shape
(`channels_push.go`, further down the same file) than to a single
forwarded gRPC stream. This solution's channel therefore combines both
existing pieces instead of introducing a third:

```go
// internal/adapter/wscompat/channels_task_activity.go (new)
type TaskActivityFrame struct {
	TaskID     string          `json:"taskId"`
	Engine     string          `json:"engine"`     // "direct_agent" | "orchestration" | "workflow" (BE-SOL-001's domain.ExecutionEngine)
	EventType  string          `json:"eventType"`  // "status_changed" | "message_posted" | "step_completed" | "decision_gate_opened"
	Payload    json.RawMessage `json:"payload"`
	OccurredAt time.Time       `json:"occurredAt"`
}

// registerTaskActivityStreamChannel subscribes one ephemeral (per-replica —
// same SubscribeEphemeral reasoning notification-service's own consumer
// doc comment gives, consumer.go:7-18: every api-gateway replica must
// independently learn about the event, since JetStream would otherwise
// round-robin it to only one replica's locally-held WS connections) NATS
// consumer per connection's subscribed taskId, translates the four
// orchestration.* + two workflow.step.* subjects into one TaskActivityFrame
// shape, and streams them via the SAME PushEvent/StreamHandler mechanism
// channels_push.go's registerNotificationStreamChannel already uses.
func registerTaskActivityStreamChannel(r *Registry, bus *eventbus.Consumer) {
	r.RegisterStream("task.activity.subscribe", func(ctx context.Context, id Identity, args []json.RawMessage) (<-chan PushEvent, error) {
		var a struct{ TaskID string `json:"taskId"` }
		if err := decodeArg(args, 0, &a); err != nil {
			return nil, err
		}
		out := make(chan PushEvent)
		go func() {
			defer close(out)
			for _, sub := range taskActivitySubjects { // the 4 orchestration.* + 2 workflow.step.* subjects
				sub := sub
				go func() {
					_ = bus.SubscribeEphemeral(ctx, sub.StreamName, sub.Subject, func(ctx context.Context, ev eventbus.Event) error {
						frame, ok := translateToTaskActivity(sub.Subject, ev, a.TaskID) // filters by task_id/origin_task_id, false if no match
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
			<-ctx.Done()
		}()
		return out, nil
	})
}
```

Filtering by `origin_task_id` for Engine 2/3 events matches the CR's own
instruction (`CR-FLOW-TASK-003.md:78-80`): Engine 2 uses
`orchestration_tasks.origin_task_id` (already a real column, per
`orchestration-service.md:143`, confirmed above); Engine 3 uses
`workflow.executions.origin_task_id` (BE-SOL-002's new column).

## Design — `task-service`'s consumer

Per the CR (`CR-FLOW-TASK-003.md:97-105`), `task-service` subscribes
`orca.orchestration.task.statuschanged` and `orca.workflow.step.completed`
(ephemeral, same pattern as `notification-service`'s
`SubscribeEphemeral`-based `Consumer` at
`services/notification-service/internal/adapter/eventbus/consumer.go:77-99`)
to update `execution_links.status_mirror` (BE-SOL-001's table) — this is
new, since `task-service` has no `adapter/eventbus/` package at all today
(confirmed: `find services/task-service -iname "*eventbus*"` → no
results). The consumer's handler is a small, single-purpose usecase:

```go
// internal/usecase/mirror_execution_status.go (new)
func (uc *MirrorExecutionStatus) Execute(ctx context.Context, in MirrorExecutionStatusInput) error {
	return uc.links.UpdateStatusMirror(ctx, in.TenantID, in.ExternalRefID, in.NewStatus)
	// A no-op (not an error) if no execution_links row matches — the same
	// idempotence posture SOL-TG-04's staleness guard already establishes
	// for this codebase's cross-service callback handlers.
}
```

## Test plan

- `orchestration-service/internal/usecase/update_task_status_and_promote_test.go`
  (extends the existing test file) — a status transition enqueues exactly
  one `orca.orchestration.task.statuschanged` outbox row in the same fake
  transaction.
- `orchestration-service/internal/usecase/create_gate_test.go` — gate
  creation enqueues `orca.orchestration.decision_gate.opened` **and** the
  minimal `orchestration.messages` insert this solution adds.
- Integration (real NATS, per `05-data-architecture.md`'s outbox-relay
  testing convention, same shape SOL-PW-04's own test plan already
  specifies): publishing `orca.orchestration.decision_gate.opened` is
  observed by `notification-service`'s **already-existing**
  `HandleIncomingEvent` — this is the CR's own acceptance criterion
  (`CR-FLOW-TASK-003.md:120`) and needs no new consumer-side code, only a
  first real publisher.
- `workflow-service/internal/usecase/wave_dispatcher_test.go` (extends the
  existing file) — a step transitioning to `completed`/`failed` enqueues
  the matching subject with `OriginTaskID` populated when
  `exec.OriginTaskID != ""`, and omitted (empty string, not absent field)
  otherwise.
- `api-gateway/internal/adapter/wscompat/channels_task_activity_test.go`
  (new) — fake `eventbus.Consumer`: one synthetic event per subject
  (4 orchestration + 2 workflow) reaches exactly one `PushEvent` on the
  channel subscribed to the matching `taskId`; an event for a different
  `taskId` reaches zero connections (per the CR's acceptance criterion,
  `CR-FLOW-TASK-003.md:122`).
- `task-service/internal/usecase/mirror_execution_status_test.go` (new) —
  a status update for an unknown `external_ref_id` is a no-op, not an
  error; a matching one updates `status_mirror` within the bounded-poll
  window SOL-PW-04's own test plan already uses as the precedent for
  "not real-time, but bounded" (`CR-FLOW-TASK-003.md:123`).

## Not in scope (per the CR)

- Continuous PTY/stdout streaming — explicitly named as `agent/` +
  `infra-fleet-service` work, flagged by SOL-TG-04, out of this CR's scope
  (`CR-FLOW-TASK-003.md:109-112`).
- Backfilling `origin_task_id` onto execution/coordinator-run rows that
  predate this solution's go-live — the CR explicitly does not require
  this (`CR-FLOW-TASK-003.md:113-115`).
- `BUG-TASKV1-005`'s full autonomous-coordinator/mailbox RPC surface
  (`PostMessage`/`ListMessages`/`RecordHeartbeat`, a real background
  dispatch loop) — this solution's `orchestration.messages` insert is
  strictly the minimum needed to make `message.posted` publish something
  real, not a substitute for that separate, larger gap.

## References

- `docs/crs/v3/flow-task/CR-FLOW-TASK-003-unified-task-activity-event-catalog.md` — full CR text
- [BE-SOL-001](./BE-SOL-001-three-engine-execution-linkage.md), [BE-SOL-002](./BE-SOL-002-workflow-as-execution-engine.md) — `ExecutionEngine`/`execution_links`/`origin_task_id` this solution's filtering depends on
- `specs/backend-go/bugs/logic-v1/solutions/SOL-PW-04-workspace-integration-event-bus.md` — the outbox/eventbus design this solution extends to a third service
- `backend-go/services/orchestration-service/migrations/0001_init.up.sql:97-99` (`orchestration.messages`'s "no RPC touches this table" comment), current file listing confirms migrations `0001`-`0003` exist, this solution adds `0004`
- `backend-go/services/orchestration-service/cmd/server/main.go:39-124` (current, real — no outbox/ticker of any kind)
- `backend-go/services/usage-service/migrations/0002_outbox.up.sql`, `cmd/server/main.go:100-109` — the working `common/outbox.Relay` precedent this solution's schema/wiring copies
- `backend-go/services/notification-service/internal/adapter/eventbus/consumer.go:44-54` (`Subjects` list — `orca.orchestration.decision_gate.opened` already present), `services/notification-service/internal/domain/notification_event.go:121-122` (translation already present) — confirms the "dead subscription" the CR names
- `backend-go/services/workflow-service/internal/usecase/wave_dispatcher.go:172-195` (`dispatchStep`, current, real — the call site this solution's step events hook)
- `backend-go/services/api-gateway/internal/adapter/wscompat/push_bridge.go:12-28`, `registry.go:104-114`, `channels_push.go:45-65` — the real `StreamHandler`/`PushEvent`/`RegisterStream` mechanism this solution's `task.activity` channel is built on, in place of SOL-PW-04's from-scratch `wsSessionRegistry` sketch
- `backend-go/common/outbox/outbox.go:1-24`, `backend-go/common/eventbus/eventbus.go:1-45` — the shared package every service's outbox/consumer wiring reuses unchanged
