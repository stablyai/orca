# TASK-014: `starNag.subscribe`/`unsubscribe` — publish `orca.tenant.star_nag.visibility_changed`, translate it in notification-service, stream it through `wscompat`

**From Solution:** SOL-005
**Priority:** P2 — depends on the usecases whose show/hide transitions it wires into
**Service:** `tenant-service` (publish) + `notification-service` (translate) + `api-gateway` (`wscompat` stream channels)
**File:** `backend-go/services/tenant-service/internal/usecase/ports.go`, `backend-go/services/tenant-service/internal/adapter/eventbus/publisher.go`, `backend-go/services/tenant-service/internal/usecase/star_nag_actions.go`, `backend-go/services/tenant-service/cmd/server/main.go`, `backend-go/services/notification-service/internal/domain/notification_event.go`, `backend-go/services/notification-service/internal/adapter/eventbus/consumer.go`, `backend-go/services/api-gateway/internal/adapter/wscompat/channels_star_nag_visibility.go` (new), `backend-go/services/api-gateway/internal/adapter/wscompat/channels.go`, `backend-go/services/api-gateway/cmd/server/main.go`
**Depends on:** TASK-011, TASK-012 (the usecases this task adds a publish call to)
**Status:** `[x]` DONE — implemented as specified across all 3 legs (tenant-service publish, notification-service translate, api-gateway filtered stream). Deviation: the task's own text says "Add a visibilityPub ... field ... to each of these 6 usecase types" but then lists 7 (Defer, ForceShow, Complete, Disable, OpenWeb, StarOrcaFromNag, ShowPreparedStarNagAgentValueMoment) — implemented all 7 per the explicit per-usecase list (the "6" was the doc's own miscount). Confirmed `item.GetType()`/`item.GetPayloadJson()` and `framePayload{title,body,deep_link,severity}` against the real notification-service proto/frame.go (matches the task's own already-corrected note, not SOL-005's original `GetBody()` guess). `buf` unaffected (no proto change this task). `go build`/`go vet` clean on tenant-service + notification-service + api-gateway; `TestDeferStarNag`/`TestForceShowStarNag` (+ new dedicated publish-assertion tests for all 7 usecases), `TestTranslateEvent` (new `star_nag_visibility` case), and `TestStarNagSubscribe`/`TestStarNagUnsubscribe` all pass.

---

## Context

The frontend's `starNag.subscribe`/`unsubscribe` streaming pair
(`runtime-star-nag-client.ts:29-77`) needs a cross-replica-safe way to learn
when a nag prompt's visibility changes on a possibly-different
tenant-service/api-gateway replica than the one that served the mutating
call. SOL-005's design reuses `notification-service`'s existing
`StreamNotifications` delivery path (already proven cross-replica-safe for
`notifications.subscribe`) rather than inventing a second transport, and
reuses `channels_push.go`'s existing `RegisterStream`/`PushEvent`
mechanism — the same pattern `registerNotificationStreamChannel` already
uses. This task wires all three legs: publish (tenant-service) → translate
(notification-service) → filtered stream (`wscompat`).

## Changes to make

### Step 1 — `tenant-service`: publisher port + implementation

Add to `ports.go`, alongside `CacheInvalidationPublisher`:

```go
// StarNagVisibilityPublisher broadcasts a star-nag prompt visibility
// transition (show/hide) so notification-service can relay it to the
// affected user's live starNag.subscribe stream, wherever it's connected —
// see specs/backend-go/bugs/missing-v3/solutions/SOL-005-starnag-channels.md
// §"Design — starNag.subscribe/unsubscribe". A nil
// StarNagVisibilityPublisher (same convention as a nil
// CacheInvalidationPublisher when NATS is unreachable at startup) means the
// mutating usecase still persists the state change correctly; only the live
// push is skipped — a client that reconnects/refetches still sees correct
// state, so this is best-effort UI responsiveness, not a durability
// requirement, same posture PublishProfileInvalidated already has.
type StarNagVisibilityPublisher interface {
	PublishStarNagVisibilityChanged(ctx context.Context, tenantID, userID, event, mode, surface string) error
}
```

Extend `internal/adapter/eventbus/publisher.go`'s existing `Publisher`
(the same struct that already implements `PublishProfileInvalidated`) with
a second subject and method — current file:

```go
const Subject = "orca.tenant.profile.invalidated"

type invalidatedPayload struct {
	UserID string `json:"user_id"`
}

type Publisher struct {
	pub *commoneventbus.Publisher
}

func New(pub *commoneventbus.Publisher) *Publisher {
	return &Publisher{pub: pub}
}

func (p *Publisher) PublishProfileInvalidated(ctx context.Context, tenantID, userID string) error {
	...
}
```

Add:

```go
// StarNagVisibilitySubject carries {tenant_id, user_id, event, mode,
// surface} — see notification-service's own eventbus/consumer.go for the
// receiving side (this subject falls under the "orca.tenant.>" wildcard
// filter Subject's own EnsureStream call already registers for the TENANT
// stream, so no new EnsureStream call is needed here).
const StarNagVisibilitySubject = "orca.tenant.star_nag.visibility_changed"

// starNagVisibilityPayload is deliberately shaped to also be a valid
// notification-service EventPayload: UserID -> UserID, and Body carries the
// JSON-encoded {event, mode, surface} triple notification-service's default
// translation rule passes through unchanged (see notification-service's
// TASK-014 step below) — this avoids inventing a second wire format for the
// same fact.
type starNagVisibilityBody struct {
	Event   string `json:"event"`             // "show" | "hide"
	Mode    string `json:"mode,omitempty"`     // "gh" | "web" — only set for "show"
	Surface string `json:"surface,omitempty"`  // "card" | "toast" — only set for "show"
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
```

Add `"time"` to this file's imports if not already present (it currently is
not, per the file as read for this task — `PublishProfileInvalidated` uses
`time.Now()` too, so check the current import block before assuming it's
missing).

### Step 2 — wire the publisher into the show/hide usecases

Modify the usecases TASK-011/TASK-012 created (`star_nag_actions.go`) to
accept `StarNagVisibilityPublisher` and call it after a successful `Save`,
nil-checked (mirrors every existing `invalidationPublisher` call site in
`internal/usecase/*.go`, e.g. `SetUserDepartment`'s own
`if uc.invalidationPublisher != nil { ... }` guard — check that exact call
site's style before writing this):

- `DeferStarNag.Execute`: after `Save`, if the publisher is non-nil,
  `_ = uc.visibilityPub.PublishStarNagVisibilityChanged(ctx, companyID, userID, "hide", "", "")` —
  best-effort, error intentionally discarded (logged, not returned) since a
  missed push is not a lost domain fact, same posture
  `PublishProfileInvalidated`'s own callers already accept.
- `ForceShowStarNag.Execute`: after `Save`, publish `"show"` with
  `mode="gh", surface="card"`.
- `CompleteStarNag`/`DisableStarNag`/`OpenWebStarNag`: publish `"hide"`
  (these all clear `ActivePrompt`).
- `StarOrcaFromNag.Execute`: publish `"hide"` only in the `starred == true`
  branch (the one that clears `ActivePrompt`) — no publish in the
  `ok == false` degrade branch, since no state changed.
- `ShowPreparedStarNagAgentValueMoment.Execute`: publish `"show"` with
  `mode="web", surface="toast"`.

Add a `visibilityPub StarNagVisibilityPublisher` field + constructor
parameter to each of these 6 usecase types, and update
`cmd/server/main.go`'s construction call sites (same section as
`invalidationPublisher`) to pass a shared
`starNagVisibilityPublisher usecase.StarNagVisibilityPublisher` variable —
set from the SAME underlying `*tenanteventbus.Publisher` instance
`invalidationPublisher` already uses when NATS is reachable (one struct
already implements both interfaces after Step 1's edit; no second
`Publisher` instance needed):

```go
var invalidationPublisher usecase.CacheInvalidationPublisher
var starNagVisibilityPublisher usecase.StarNagVisibilityPublisher
...
} else {
	...
	sharedPublisher := tenanteventbus.New(pub)
	invalidationPublisher = sharedPublisher
	starNagVisibilityPublisher = sharedPublisher
	...
}
```

### Step 3 — `notification-service`: add the subject

Add to `internal/adapter/eventbus/consumer.go`'s `Subjects` slice:

```go
{StreamName: "TENANT", Subject: "orca.tenant.star_nag.visibility_changed"},
```

Add to `internal/domain/notification_event.go`'s `subjectRules` map:

```go
"orca.tenant.star_nag.visibility_changed": {
	Type: "star_nag_visibility", Title: "", Body: "",
	Severity: SeverityInfo, Channels: []DeliveryChannel{ChannelDeliveryWS},
},
```

No other `notification_event.go` change is needed: `TranslateEvent`
already overrides `rule.Body` with `payload.Body` when the incoming
payload's `Body` field is non-empty (`notification_event.go:156-159`) —
Step 1's `starNagVisibilityPayload.Body` (the JSON-encoded
`{event,mode,surface}` triple) flows straight through as
`NotificationEvent.Body` untouched, no new domain field required, matching
`notification-service.md` §3's "a new subject can be added without a schema
change" design. `recipientsOf` already reads `payload.UserID`
(`notification_event.go:39,177-184`), which Step 1's payload also sets.

### Step 4 — `wscompat`: `starNag.subscribe`/`unsubscribe`

Create `backend-go/services/api-gateway/internal/adapter/wscompat/channels_star_nag_visibility.go`:

```go
// starNag.subscribe/unsubscribe — see channels_star_nag.go's doc comment
// for the split rationale, and
// specs/backend-go/bugs/missing-v3/solutions/SOL-005-starnag-channels.md's
// "Design — starNag.subscribe/unsubscribe" section for why this opens its
// own filtered StreamNotifications call rather than reusing
// notifications.subscribe's or inventing a new transport.
package wscompat

import (
	"context"
	"encoding/json"
)

// starNagVisibilityFramePayload mirrors framePayload's wire shape
// (notification-service's internal/adapter/grpc/frame.go) — the JSON
// notification-service actually puts into
// NotificationServiceStreamNotificationsResponse.PayloadJson. Body is
// itself a second layer of JSON (see tenant-service's
// starNagVisibilityBody) — double-encoded rather than a new proto field,
// per notification-service's own "no schema change" design for this
// subject (see TASK-014 Step 3's note in the SOL-005 task set).
type starNagVisibilityFramePayload struct {
	Body string `json:"body"`
}

type starNagVisibilityBody struct {
	Event   string `json:"event"`
	Mode    string `json:"mode,omitempty"`
	Surface string `json:"surface,omitempty"`
}

// runtimeStarNagVisibilityEvent matches RuntimeStarNagVisibilityEvent
// (runtime-star-nag-client.ts:11-13) — {type:'show', mode, surface} or
// {type:'hide'}.
type runtimeStarNagVisibilityEvent struct {
	Type    string `json:"type"`
	Mode    string `json:"mode,omitempty"`
	Surface string `json:"surface,omitempty"`
}

func registerStarNagVisibilityStreamChannel(r *Registry, opener NotificationStreamOpener) {
	r.RegisterStream("starNag.subscribe", func(ctx context.Context, id Identity, args []json.RawMessage) (<-chan PushEvent, error) {
		stream, err := opener(ctx, id.UserID)
		if err != nil {
			return nil, err
		}
		out := make(chan PushEvent)
		go func() {
			defer close(out)
			for {
				item, err := stream.Recv()
				if err != nil {
					return
				}
				if item.GetType() != "star_nag_visibility" {
					continue // this filtered view only forwards star-nag frames
				}
				var frame starNagVisibilityFramePayload
				if err := json.Unmarshal([]byte(item.GetPayloadJson()), &frame); err != nil {
					continue
				}
				var body starNagVisibilityBody
				if err := json.Unmarshal([]byte(frame.Body), &body); err != nil {
					continue
				}
				ev := runtimeStarNagVisibilityEvent{Type: body.Event, Mode: body.Mode, Surface: body.Surface}
				select {
				case out <- PushEvent{Channel: "starNag.event", Args: []any{ev}}:
				case <-ctx.Done():
					return
				}
			}
		}()
		return out, nil
	})

	// starNag.unsubscribe — an honest no-op. wscompat has no generic
	// mid-connection subscription-cancel primitive (unlike
	// terminal.subscribe/unsubscribe's per-subscriptionId registry, which
	// exists because a single connection can hold MULTIPLE concurrent
	// terminal subscriptions needing individual addressing —
	// starNag.subscribe has exactly one logical subscription per
	// connection, the same shape notifications.subscribe already has
	// without an .unsubscribe sibling). pipePush's subscription lifetime is
	// tied to the connection's own ctx and ends only when the WebSocket
	// closes — see push_bridge.go. Acking without tearing anything down
	// mid-connection is the same "accept the call, no-op the part that
	// doesn't map" answer BUG-014's telemetry.track stub already documents,
	// here for a protocol-shape reason instead of a missing-backend reason.
	r.Register("starNag.unsubscribe", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		return map[string]bool{"unsubscribed": true}, nil
	})
}
```

Note: `item.GetType()`/`item.GetPayloadJson()` are the real
`NotificationServiceStreamNotificationsResponse` proto field
accessors — confirmed against `notification.proto:45-49`
(`{id, type, payload_json}`), NOT `GetBody()` as SOL-005's own design sketch
guessed; use `GetPayloadJson()`.

### Step 5 — wire into `RegisterPushChannels` and `channels.go`/`main.go`

`channels_push.go`'s `RegisterPushChannels(r *Registry,
notificationStreamOpener NotificationStreamOpener, bus *ClientEventBus)`
already calls `registerNotificationStreamChannel(r,
notificationStreamOpener)`. Add, right after it:

```go
	registerStarNagVisibilityStreamChannel(r, notificationStreamOpener)
```

No `main.go` change needed — `RegisterPushChannels` is already called with
the shared `notificationStreamOpener` (`main.go:256`); this task only adds
a call inside that existing function.

## Verify

```bash
cd backend-go
go build ./services/tenant-service/... ./services/notification-service/... ./services/api-gateway/...
go vet ./services/tenant-service/... ./services/notification-service/... ./services/api-gateway/...
go test ./services/tenant-service/internal/usecase/... -run TestDeferStarNag -run TestForceShowStarNag -count=1 -v
go test ./services/notification-service/internal/domain/... -run TestTranslateEvent -count=1 -v
go test ./services/api-gateway/internal/adapter/wscompat/... -run TestStarNagSubscribe -run TestStarNagUnsubscribe -count=1 -v
```

Test-plan detail for the new `channels_star_nag_visibility_test.go` (add
alongside the new file): a fake `NotificationStreamOpener` emitting a mixed
stream of one `star_nag_visibility`-typed frame and one unrelated
`NotificationFrame` (e.g. `type: "task_completed"`), asserting only the
former reaches the returned `PushEvent` channel, decoded into the expected
`runtimeStarNagVisibilityEvent{Type:"show", Mode:"gh", Surface:"card"}`
shape; `starNag.unsubscribe` asserts the `{"unsubscribed": true}` ack shape
and that no registry/side-effect exists to assert against (the honest
no-op has none by design).
