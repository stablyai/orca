package domain

import (
	"encoding/json"
	"errors"
	"time"
)

// DeliveryChannel is a way a NotificationEvent can reach a user — WS
// fan-out (through api-gateway) or mobile push (APNs/FCM), the two
// distinct delivery mechanisms notification-service.md keeps separate
// throughout (§1).
type DeliveryChannel string

const (
	ChannelDeliveryWS   DeliveryChannel = "ws"
	ChannelDeliveryPush DeliveryChannel = "push"
)

// Severity classifies how urgently a NotificationEvent should be surfaced.
type Severity string

const (
	SeverityInfo     Severity = "info"
	SeverityWarning  Severity = "warning"
	SeverityCritical Severity = "critical"
)

// ErrNoRecipients is returned by TranslateEvent when the source event's
// payload names no user to notify — nothing to broadcast, per §2 (no
// offline WS replay queue): a notification nobody can receive is a no-op,
// not a delivery worth retrying.
var ErrNoRecipients = errors.New("domain: event payload names no recipient user")

// EventPayload is the generic shape TranslateEvent decodes a consumed bus
// event's JSON payload into. Per §3, the subject list is illustrative, not
// exhaustive — a new publisher's payload only needs to carry these
// well-known fields to be translatable without a schema change here.
type EventPayload struct {
	UserID   string   `json:"user_id,omitempty"`
	UserIDs  []string `json:"user_ids,omitempty"`
	Title    string   `json:"title,omitempty"`
	Body     string   `json:"body,omitempty"`
	DeepLink string   `json:"deep_link,omitempty"`
}

// DecodePayload unmarshals a bus event's raw JSON payload into an
// EventPayload. Kept in domain/ (encoding/json is stdlib, so this stays
// within the zero-framework-imports rule) so malformed-payload handling is
// unit-testable alongside TranslateEvent, and usecase/ doesn't need its own
// decode step.
func DecodePayload(raw []byte) (EventPayload, error) {
	if len(raw) == 0 {
		return EventPayload{}, nil
	}
	var p EventPayload
	if err := json.Unmarshal(raw, &p); err != nil {
		return EventPayload{}, err
	}
	return p, nil
}

// NotificationEvent is the internal representation after translating a
// domain event (task/workflow/automation/credential/orchestration) into
// something user-facing — see notification-service.md §4. TranslateEvent
// produces this; DeliverWS/DeliverPush (broadcaster/push adapters) each
// consume it independently.
type NotificationEvent struct {
	ID               string
	TenantID         string
	RecipientUserIDs []string
	SourceEventID    string
	SourceSubject    string
	Type             string
	Title            string
	Body             string
	DeepLink         string
	Severity         Severity
	Channels         []DeliveryChannel
	CreatedAt        time.Time
}

// subjectRule is one row of §3's subject table: how a subject maps to a
// notification's type/title/body/severity/channels absent payload
// overrides.
type subjectRule struct {
	Type     string
	Title    string
	Body     string
	Severity Severity
	Channels []DeliveryChannel
}

// subjectRules is illustrative, not exhaustive (§3) — a subject missing
// from this table still translates, via defaultRule, so a new publisher
// doesn't require a code change here to produce a (generic) notification.
var subjectRules = map[string]subjectRule{
	"orca.task.task.completed": {
		Type: "task_completed", Title: "Task completed", Body: "Your task has finished.",
		Severity: SeverityInfo, Channels: []DeliveryChannel{ChannelDeliveryWS, ChannelDeliveryPush},
	},
	"orca.workflow.execution.completed": {
		Type: "workflow_completed", Title: "Workflow finished", Body: "Your workflow execution has completed.",
		Severity: SeverityInfo, Channels: []DeliveryChannel{ChannelDeliveryWS, ChannelDeliveryPush},
	},
	"orca.workflow.execution.failed": {
		Type: "workflow_failed", Title: "Workflow failed", Body: "Your workflow execution has failed.",
		Severity: SeverityWarning, Channels: []DeliveryChannel{ChannelDeliveryWS, ChannelDeliveryPush},
	},
	"orca.automation.run.completed": {
		Type: "automation_run_completed", Title: "Automation run finished", Body: "Your automation run has completed.",
		Severity: SeverityInfo, Channels: []DeliveryChannel{ChannelDeliveryWS, ChannelDeliveryPush},
	},
	"orca.credential.credential.rotated": {
		// "Always delivered regardless of preferences" per §2 — this
		// scaffold has no preference filter at all yet, so "always" is
		// trivially true today, not an enforced override.
		Type: "credential_rotated", Title: "Security alert: credential rotated", Body: "One of your credentials was rotated.",
		Severity: SeverityCritical, Channels: []DeliveryChannel{ChannelDeliveryWS, ChannelDeliveryPush},
	},
	"orca.orchestration.decision_gate.opened": {
		Type: "decision_gate_opened", Title: "Needs your decision", Body: "A workflow is waiting on your decision.",
		Severity: SeverityWarning, Channels: []DeliveryChannel{ChannelDeliveryWS, ChannelDeliveryPush},
	},
	// starNag.subscribe's cross-replica visibility push (TASK-014, SOL-005)
	// — WS-only (no push notification for a UI-prompt-visibility toggle),
	// empty Title/Body: payload.Body always carries the real
	// {event,mode,surface} JSON triple (tenant-service's
	// starNagVisibilityBody), which the payload.Body != "" override below
	// passes through unchanged — no schema change needed here, per
	// notification-service.md §3's "a new subject can be added without a
	// schema change" design.
	"orca.tenant.star_nag.visibility_changed": {
		Type: "star_nag_visibility", Title: "", Body: "",
		Severity: SeverityInfo, Channels: []DeliveryChannel{ChannelDeliveryWS},
	},
}

// defaultRule is used for any subject not in subjectRules — WS-only,
// informational, so an unrecognized publisher's event degrades safely
// instead of being silently dropped.
var defaultRule = subjectRule{
	Type: "generic", Title: "Notification", Body: "",
	Severity: SeverityInfo, Channels: []DeliveryChannel{ChannelDeliveryWS},
}

// TranslateEvent maps one consumed bus event into a NotificationEvent —
// pure and unit-testable without touching NATS/Postgres, per
// architecture/03's domain-layer-has-zero-framework-imports rule. id is the
// NotificationEvent's own identity (generated by the caller, e.g. via
// uuid.NewString() in usecase/); sourceEventID/subject/tenantID/occurredAt
// come from the consumed bus envelope (common/eventbus.Event).
func TranslateEvent(id, sourceEventID, subject, tenantID string, payload EventPayload, occurredAt time.Time) (NotificationEvent, error) {
	recipients := recipientsOf(payload)
	if len(recipients) == 0 {
		return NotificationEvent{}, ErrNoRecipients
	}

	rule, ok := subjectRules[subject]
	if !ok {
		rule = defaultRule
	}

	title := rule.Title
	if payload.Title != "" {
		title = payload.Title
	}
	body := rule.Body
	if payload.Body != "" {
		body = payload.Body
	}

	return NotificationEvent{
		ID:               id,
		TenantID:         tenantID,
		RecipientUserIDs: recipients,
		SourceEventID:    sourceEventID,
		SourceSubject:    subject,
		Type:             rule.Type,
		Title:            title,
		Body:             body,
		DeepLink:         payload.DeepLink,
		Severity:         rule.Severity,
		Channels:         rule.Channels,
		CreatedAt:        occurredAt,
	}, nil
}

func recipientsOf(p EventPayload) []string {
	if len(p.UserIDs) > 0 {
		return p.UserIDs
	}
	if p.UserID != "" {
		return []string{p.UserID}
	}
	return nil
}
