# TASK-FT-003-02: `orchestration.messages`'s first real write + `decision_gate.opened`/`message.posted` outbox events

**From Solution:** BE-SOL-003
**Priority:** P0
**Service:** `orchestration-service`
**File:** `backend-go/services/orchestration-service/internal/usecase/ports.go` (`GateRepository` signatures widened), `backend-go/services/orchestration-service/internal/usecase/create_gate.go`, `resolve_gate.go` (call sites), `backend-go/services/orchestration-service/internal/adapter/postgres/repository.go` (`CreateGate`/`ResolveGate` widened)
**Depends on:** TASK-FT-003-01 (`orchestration.outbox_events` table, `domain.OutboxEvent`, `common/outbox.Store` on `*Repository`)
**Status:** `[ ]` TODO

---

## Context

Verified against the real migration comment
(`orchestration-service/migrations/0001_init.up.sql`, confirmed by
reading the file directly): `orchestration.messages` ("the coordinator's
mailbox") has **zero** RPC coverage today — "No RPC in the current
generated proto (PostMessage/ListMessages/MarkMessageRead) touches this
table yet." CR-FLOW-TASK-003 is explicit that this CR is "the first
reason the table needs to be written for real." This task's minimal scope
is: `CreateGate`/`ResolveGate` each insert one `orchestration.messages`
row of type `decision_gate` in the same transaction as their existing
write, purely so the outbox has a real row to enqueue from — **this is
not** a general-purpose `PostMessage` usecase (that full mailbox RPC
surface, `PostMessage`/`ListMessages`/`RecordHeartbeat`, is
`BUG-TASKV1-005`'s separate, tracked scope). If `BUG-TASKV1-005`'s work
lands first, its `PostMessage` usecase becomes this subject's real writer
instead, and this task's minimal insert is superseded, not duplicated —
check whether `orchestration.messages` already has a real write path
before adding a second one.

Verified real, current call sites: `CreateGate.Execute`
(`create_gate.go:39-67`) calls `uc.repo.CreateGate(ctx, tenantID,
in.DispatchContextID, in.Question, in.Options)` inside
`uc.serializer.Do(...)`; `GateRepository.CreateGate`
(`ports.go:110-124`) already documents that it "atomically resolves
dispatchContextID to its owning orchestration_task_id, inserts the gate
row, and transitions that task to blocked — all in one transaction," and
the real `internal/adapter/postgres/repository.go`'s `CreateGate`
(`:447-515`) confirms an internal `tx` is already open there. Same for
`ResolveGate` (`resolve_gate.go:39-68`, `repository.go:516-577`).

This is also `notification-service`'s already-verified "dead
subscription" — its `Subjects` list already includes
`{StreamName: "ORCHESTRATION", Subject:
"orca.orchestration.decision_gate.opened"}`
(`consumer.go:50`) and its translation already exists
(`notification_event.go:121-122`: `Type: "decision_gate_opened", Title:
"Needs your decision"`) — this task's job is entirely publish-side; no
consumer-side code is needed for `decision_gate.opened` to start working
end-to-end.

## Changes to make

**1. `ports.go`** — widen `GateRepository`:

```go
type GateRepository interface {
	CreateGate(ctx context.Context, tenantID, dispatchContextID, question string, options []string, event domain.OutboxEvent) (domain.DecisionGate, error)
	ResolveGate(ctx context.Context, tenantID, gateID, resolution string, event domain.OutboxEvent) (domain.DecisionGate, []string, error)
}
```

**2. `internal/adapter/postgres/repository.go`** — inside `CreateGate`'s
existing transaction (`:447-515`), after the existing gate-insert +
task-status-update statements, before `tx.Commit`:

Verified real, full column list (`0001_init.up.sql`, `CREATE TABLE
orchestration.messages`): `sequence BIGSERIAL PRIMARY KEY, tenant_id,
from_handle, to_handle, subject, body, type` (CHECK-constrained to
`'status','dispatch','worker_done','merge_ready','escalation','handoff',
'decision_gate','heartbeat'` — `'decision_gate'` already a valid value,
no CHECK-constraint change needed), `thread_id, payload JSONB, read
BOOLEAN DEFAULT false, delivered_at, created_at`:

```go
// orchestration.messages' first real write (CR-FLOW-TASK-003) — a
// minimal mailbox entry, not a general PostMessage usecase; see this
// task's Context.
if _, err := tx.Exec(ctx, `
	INSERT INTO orchestration.messages (tenant_id, from_handle, to_handle, subject, body, type, payload)
	VALUES ($1, 'coordinator', $2, 'Decision needed', $3, 'decision_gate', $4::jsonb)
`, tenantID, toHandle, question, messagePayloadJSON); err != nil {
	return domain.DecisionGate{}, fmt.Errorf("postgres: insert coordinator message: %w", err)
}
if event.ID != "" {
	if _, err := tx.Exec(ctx, `
		INSERT INTO orchestration.outbox_events (id, tenant_id, subject, occurred_at, version, payload)
		VALUES ($1, $2, $3, $4, 1, $5::jsonb)
	`, event.ID, tenantID, event.Subject, event.OccurredAt, event.PayloadJSON); err != nil {
		return domain.DecisionGate{}, fmt.Errorf("postgres: insert outbox event: %w", err)
	}
}
```

`to_handle` here is the gate's owning task/coordinator handle — resolve
it the same way `CreateGate`'s existing code already resolves
`dispatchContextID` to its owning `orchestration_task_id` (reuse that
lookup, don't add a second one); `body` carries `question` directly
(`TEXT`, already the right shape); `payload` carries the JSON-encoded
`options` list.

Same shape for `ResolveGate` (`:516-577`), `message_type = 'decision_gate'`
again, subject `orca.orchestration.decision_gate.resolved` is **not**
one of the CR's 4 named subjects (only `.opened` is) — `ResolveGate`'s
outbox insert here is for the `orchestration.messages` row only, matching
CR-FLOW-TASK-003's subject table; do not invent a `.resolved` subject
this task doesn't need.

**3. `create_gate.go`/`resolve_gate.go`** — build the outbox event before
calling the repository:

```go
// create_gate.go, inside Execute, before uc.repo.CreateGate:
payload, err := json.Marshal(decisionGateOpenedPayload{
	DispatchContextID: in.DispatchContextID, Question: in.Question, Options: in.Options,
})
var event domain.OutboxEvent
if err == nil {
	event = domain.OutboxEvent{ID: uuid.NewString(), Subject: "orca.orchestration.decision_gate.opened", OccurredAt: time.Now().UTC(), PayloadJSON: payload}
}
// ... uc.serializer.Do wraps uc.repo.CreateGate(ctx, tenantID, in.DispatchContextID, in.Question, in.Options, event) ...
```

## Verify

```bash
cd /opt/repos/orca/backend-go
go build ./services/orchestration-service/...
go test ./services/orchestration-service/internal/usecase/... -run "TestCreateGate|TestResolveGate" -v
```

Expected: `CreateGate` enqueues exactly one
`orca.orchestration.decision_gate.opened` outbox row **and** the minimal
`orchestration.messages` insert, both in the same fake/real transaction
as the existing gate-creation write. Once deployed (this task plus
TASK-FT-003-01's relay wiring), `notification-service`'s
already-existing `HandleIncomingEvent` — no new consumer-side code —
starts receiving real events; confirm this end-to-end against a real NATS
instance, it is the CR's own acceptance criterion.
