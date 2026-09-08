// Push-capable channels — StreamHandler registrations (Registry.RegisterStream),
// distinct from channels.go's request/response ChannelHandler registrations.
// Kept in this SEPARATE file (not appended to channels.go) so this pass's
// edits never touch the shared, high-churn channels.go other in-flight
// work also edits — see docs/execution-plan.md's frontend-compatibility
// coverage table for the full channel inventory. RegisterPushChannels is
// the one call cmd/server/main.go's composition root needs, mirroring
// RegisterRealChannels's existing shape.
package wscompat

import (
	"context"
	"encoding/json"
	"sync"

	notificationv1 "github.com/stablyai/orca-go/proto/gen/go/orca/notification/v1"
)

// NotificationStreamOpener opens a live StreamNotifications gRPC call for
// userID. Deliberately redeclared here (identical signature) rather than
// importing internal/adapter/wsbridge.StreamOpener directly: wsbridge
// already imports this package (for wscompat.Identity), so importing
// wsbridge back from here would be an import cycle. main.go's composition
// root passes the SAME *wsbridge.StreamOpener-typed func value to both
// wsbridge.New(...) and RegisterPushChannels via an explicit conversion
// (identical underlying function type, so the conversion is a no-op at
// runtime) — never construct a second stream-opening closure.
type NotificationStreamOpener func(ctx context.Context, userID string) (notificationv1.NotificationService_StreamNotificationsClient, error)

// RegisterPushChannels wires every StreamHandler-backed (push-capable)
// channel this pass adds. Called once from main.go's composition root,
// alongside (not instead of) RegisterRealChannels.
func RegisterPushChannels(r *Registry, notificationStreamOpener NotificationStreamOpener, bus *ClientEventBus) {
	registerNotificationStreamChannel(r, notificationStreamOpener)
	registerStarNagVisibilityStreamChannel(r, notificationStreamOpener)
	registerClientEventsChannel(r, bus)
}

// ── notifications.* (stream) ────────────────────────────────────────────
//
// Reuses wsbridge.StreamOpener's exact "open a server-streaming gRPC call,
// forward each item" shape — see internal/adapter/wsbridge/handler.go for
// the proven precedent this generalizes, rather than reimplementing
// gRPC-stream-to-channel plumbing a second time.
func registerNotificationStreamChannel(r *Registry, opener NotificationStreamOpener) {
	r.RegisterStream("notifications.subscribe", func(ctx context.Context, id Identity, args []json.RawMessage) (<-chan PushEvent, error) {
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
					return // stream closed or ctx cancelled — pipePush's caller sees the closed channel and returns too
				}
				select {
				case out <- PushEvent{Channel: "notifications.event", Args: []any{item}}:
				case <-ctx.Done():
					return
				}
			}
		}()
		return out, nil
	})
}

// ── runtime.clientEvents.* (local in-process fan-out) ───────────────────

// ClientEventBus is a tiny in-process pub/sub for gateway-local events —
// deliberately NOT cross-replica (matches the old backend's "in-memory WS
// event fan-out" description for this exact channel). Any api-gateway
// replica handling this connection sees only events published on that same
// replica — acceptable per 08-inter-service-communication.md's
// stateless-by-design principle, since this is UI-convenience signaling,
// not state that must be consistent cluster-wide. Exported (unlike a
// package-private bus) so cmd/server/main.go can construct one and hand a
// Publish-capable reference to whatever other code needs to publish client
// events, once such a call site exists — see RegisterPushChannels's doc
// comment: this task only wires the subscribe side.
type ClientEventBus struct {
	mu   sync.Mutex
	subs map[chan PushEvent]struct{}
}

func NewClientEventBus() *ClientEventBus {
	return &ClientEventBus{subs: make(map[chan PushEvent]struct{})}
}

func (b *ClientEventBus) Subscribe() (<-chan PushEvent, func()) {
	ch := make(chan PushEvent, 16)
	b.mu.Lock()
	b.subs[ch] = struct{}{}
	b.mu.Unlock()
	unsubscribe := func() {
		b.mu.Lock()
		if _, ok := b.subs[ch]; ok {
			delete(b.subs, ch)
			close(ch)
		}
		b.mu.Unlock()
	}
	return ch, unsubscribe
}

func (b *ClientEventBus) Publish(ev PushEvent) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for ch := range b.subs {
		select {
		case ch <- ev:
		default: // slow subscriber — drop rather than block Publish
		}
	}
}

func registerClientEventsChannel(r *Registry, bus *ClientEventBus) {
	r.RegisterStream("runtime.clientEvents.subscribe", func(ctx context.Context, id Identity, args []json.RawMessage) (<-chan PushEvent, error) {
		ch, unsubscribe := bus.Subscribe()
		go func() { <-ctx.Done(); unsubscribe() }()
		return ch, nil
	})
}
