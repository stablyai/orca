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
// subject.
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
