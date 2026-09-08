// Package eventbus implements tenant-service's cross-replica profile-cache
// invalidation broadcast against NATS JetStream via common/eventbus — see
// docs/execution-plan.md Epic F and this service's README "Known gaps" for
// why this exists: internal/adapter/cache.LRUTTLCache is an in-process
// cache, one instance per replica. A mutating usecase already invalidates
// the entry on the replica that served the write; the remaining gap was
// that every OTHER replica's copy of the same entry stayed correct only by
// waiting out its TTL, not by being told. Publishing this event is
// best-effort, not outbox-backed: a missed publish just means a peer
// replica falls back to today's TTL-bounded staleness, never wrong data —
// this doesn't need the stronger at-least-once guarantee a
// domain-of-record event would.
package eventbus

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"

	commoneventbus "github.com/stablyai/orca-go/common/eventbus"
)

// Subject is the event subject SetUserDepartment/AddTeamMember publish to
// after invalidating their own replica's cache entry. Every tenant-service
// replica (including the publisher) also subscribes to this subject — see
// consumer.go — so a resolved-profile cache stays correct cluster-wide
// within event-delivery latency, not just within
// usecase.DefaultProfileCacheTTL.
const Subject = "orca.tenant.profile.invalidated"

type invalidatedPayload struct {
	UserID string `json:"user_id"`
}

// Publisher implements usecase.CacheInvalidationPublisher.
type Publisher struct {
	pub *commoneventbus.Publisher
}

func New(pub *commoneventbus.Publisher) *Publisher {
	return &Publisher{pub: pub}
}

func (p *Publisher) PublishProfileInvalidated(ctx context.Context, tenantID, userID string) error {
	payload, err := json.Marshal(invalidatedPayload{UserID: userID})
	if err != nil {
		return fmt.Errorf("eventbus: marshal payload: %w", err)
	}
	return p.pub.Publish(ctx, Subject, commoneventbus.Event{
		ID:         uuid.NewString(),
		TenantID:   tenantID,
		OccurredAt: time.Now().UTC(),
		Version:    1,
		Payload:    payload,
	})
}

// StarNagVisibilitySubject carries {tenant_id, user_id, event, mode,
// surface} — see notification-service's own eventbus/consumer.go for the
// receiving side (this subject falls under the "orca.tenant.>" wildcard
// filter Subject's own EnsureStream call already registers for the TENANT
// stream, so no new EnsureStream call is needed here).
const StarNagVisibilitySubject = "orca.tenant.star_nag.visibility_changed"

// starNagVisibilityBody is deliberately shaped to also be a valid
// notification-service EventPayload: UserID -> UserID, and Body carries the
// JSON-encoded {event, mode, surface} triple notification-service's default
// translation rule passes through unchanged (see notification-service's
// TranslateEvent) — this avoids inventing a second wire format for the
// same fact.
type starNagVisibilityBody struct {
	Event   string `json:"event"`             // "show" | "hide"
	Mode    string `json:"mode,omitempty"`    // "gh" | "web" — only set for "show"
	Surface string `json:"surface,omitempty"` // "card" | "toast" — only set for "show"
}

type starNagVisibilityPayload struct {
	UserID string `json:"user_id"`
	Body   string `json:"body"`
}

func (p *Publisher) PublishStarNagVisibilityChanged(ctx context.Context, tenantID, userID, event, mode, surface string) error {
	body, err := json.Marshal(starNagVisibilityBody{Event: event, Mode: mode, Surface: surface})
	if err != nil {
		return fmt.Errorf("eventbus: marshal star nag visibility body: %w", err)
	}
	payload, err := json.Marshal(starNagVisibilityPayload{UserID: userID, Body: string(body)})
	if err != nil {
		return fmt.Errorf("eventbus: marshal star nag visibility payload: %w", err)
	}
	return p.pub.Publish(ctx, StarNagVisibilitySubject, commoneventbus.Event{
		ID:         uuid.NewString(),
		TenantID:   tenantID,
		OccurredAt: time.Now().UTC(),
		Version:    1,
		Payload:    payload,
	})
}
