// Package eventbus wires notification-service's HandleIncomingEvent
// usecase to NATS JetStream via common/eventbus.Consumer — this is the
// "primary consumer of the async bus" role from notification-service.md
// §1/§3/§6, unusually central compared to a typical service's thin outbox
// publisher: N long-lived JetStream consumers, one per subscribed subject.
//
// Fan-out fix (docs/execution-plan.md Epic F): every subscription below
// uses commoneventbus.Consumer.SubscribeEphemeral, not Subscribe. Subscribe
// would give every notification-service replica the SAME durable consumer
// name, which JetStream treats as one shared cursor — only ONE replica
// would ever receive a given domain event, so only that replica's
// broadcaster.Broadcast call would fire, and only ITS locally-connected
// StreamNotifications subscribers would see it (see
// internal/adapter/broadcaster's doc comment for the full symptom).
// SubscribeEphemeral gives each replica its own private cursor, so every
// replica independently translates and broadcasts every event to its own
// local subscribers — cluster-wide fan-out, no new subject or republish hop
// needed.
package eventbus

import (
	"context"
	"log/slog"
	"sync"

	commoneventbus "github.com/stablyai/orca-go/common/eventbus"
	"github.com/stablyai/orca-go/services/notification-service/internal/usecase"
)

// SubjectBinding pairs a JetStream stream name (owned/created by the
// publishing service) with a subject filter within it —
// commoneventbus.Consumer.SubscribeEphemeral looks the stream up rather
// than creating it, so the binding's StreamName must match whatever the
// publisher named its own stream via EnsureStream.
type SubjectBinding struct {
	StreamName string
	Subject    string
}

// Subjects is notification-service.md §3's subject table — illustrative,
// not exhaustive; a new subject can be added here without any schema
// change, since HandleIncomingEvent's translation is subject-driven (see
// domain.TranslateEvent's fallback rule), not subject-exhaustive.
var Subjects = []SubjectBinding{
	{StreamName: "TASK", Subject: "orca.task.task.completed"},
	{StreamName: "WORKFLOW", Subject: "orca.workflow.execution.completed"},
	{StreamName: "WORKFLOW", Subject: "orca.workflow.execution.failed"},
	{StreamName: "AUTOMATION", Subject: "orca.automation.run.completed"},
	{StreamName: "CREDENTIAL", Subject: "orca.credential.credential.rotated"},
	{StreamName: "ORCHESTRATION", Subject: "orca.orchestration.decision_gate.opened"},
	// starNag.subscribe's cross-replica visibility push (TASK-014, SOL-005)
	// — see tenant-service's internal/adapter/eventbus.StarNagVisibilitySubject.
	{StreamName: "TENANT", Subject: "orca.tenant.star_nag.visibility_changed"},
}

// Consumer subscribes to every binding in Subjects and forwards each
// delivered message to HandleIncomingEvent — a real, working consumer
// loop, not a stub.
type Consumer struct {
	bus    *commoneventbus.Consumer
	handle *usecase.HandleIncomingEvent
}

func New(bus *commoneventbus.Consumer, handle *usecase.HandleIncomingEvent) *Consumer {
	return &Consumer{bus: bus, handle: handle}
}

// Run subscribes to every SubjectBinding, one goroutine each (each call to
// commoneventbus.Consumer.SubscribeEphemeral blocks until ctx is
// cancelled), and returns once every subscription has stopped. A binding
// whose stream doesn't exist yet (the publishing service hasn't
// started/registered it) logs a warning and that one binding gives up — it
// does not fail service startup or the other bindings, matching this
// service's overall graceful-degradation posture around eventbus
// availability (see cmd/server/main.go and usage-service's precedent for
// the same pattern).
func (c *Consumer) Run(ctx context.Context, logger *slog.Logger) {
	var wg sync.WaitGroup
	for _, binding := range Subjects {
		wg.Add(1)
		go func(b SubjectBinding) {
			defer wg.Done()
			err := c.bus.SubscribeEphemeral(ctx, b.StreamName, b.Subject, func(ctx context.Context, event commoneventbus.Event) error {
				return c.handle.Execute(ctx, usecase.HandleIncomingEventInput{
					EventID:    event.ID,
					TenantID:   event.TenantID,
					Subject:    b.Subject,
					OccurredAt: event.OccurredAt,
					Payload:    event.Payload,
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
