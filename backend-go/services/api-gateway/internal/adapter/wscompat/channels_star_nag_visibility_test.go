package wscompat

import (
	"context"
	"testing"
	"time"

	notificationv1 "github.com/stablyai/orca-go/proto/gen/go/orca/notification/v1"
)

// TestStarNagSubscribe_OnlyForwardsStarNagFrames drives
// registerStarNagVisibilityStreamChannel's StreamHandler directly with a
// fake stream emitting one star_nag_visibility frame and one unrelated
// frame — asserts only the former reaches the returned PushEvent channel,
// decoded into the expected runtimeStarNagVisibilityEvent shape.
func TestStarNagSubscribe_OnlyForwardsStarNagFrames(t *testing.T) {
	stream := &fakeNotificationStream{items: []*notificationv1.NotificationServiceStreamNotificationsResponse{
		{Id: "evt-1", Type: "task_completed", PayloadJson: `{"title":"Task done","body":"x"}`},
		{Id: "evt-2", Type: "star_nag_visibility", PayloadJson: `{"body":"{\"event\":\"show\",\"mode\":\"gh\",\"surface\":\"card\"}"}`},
	}}
	opener := NotificationStreamOpener(func(ctx context.Context, userID string) (notificationv1.NotificationService_StreamNotificationsClient, error) {
		return stream, nil
	})

	registry := NewRegistry()
	registerStarNagVisibilityStreamChannel(registry, opener)

	sh, ok := registry.StreamHandlerFor("starNag.subscribe")
	if !ok {
		t.Fatal("expected starNag.subscribe to be registered")
	}

	events, err := sh(context.Background(), Identity{UserID: "user-1"}, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	select {
	case ev, ok := <-events:
		if !ok {
			t.Fatal("expected exactly one delivered event, channel closed instead")
		}
		if ev.Channel != "starNag.event" {
			t.Fatalf("expected channel=starNag.event, got %q", ev.Channel)
		}
		if len(ev.Args) != 1 {
			t.Fatalf("expected exactly one arg, got %v", ev.Args)
		}
		got, ok := ev.Args[0].(runtimeStarNagVisibilityEvent)
		if !ok {
			t.Fatalf("unexpected arg type %T", ev.Args[0])
		}
		want := runtimeStarNagVisibilityEvent{Type: "show", Mode: "gh", Surface: "card"}
		if got != want {
			t.Errorf("got %+v, want %+v", got, want)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for the star_nag_visibility frame")
	}

	// The unrelated task_completed frame must never surface; the channel
	// should close cleanly once the stream is exhausted (fakeNotificationStream
	// returns io.EOF after its queued items).
	select {
	case _, ok := <-events:
		if ok {
			t.Fatal("expected no further events (the task_completed frame must be filtered out)")
		}
	case <-time.After(time.Second):
		t.Fatal("expected the events channel to close after the stream is exhausted")
	}
}

func TestStarNagUnsubscribe_AcksWithoutAnyRegistry(t *testing.T) {
	registry := NewRegistry()
	registerStarNagVisibilityStreamChannel(registry, nil)

	result, err := registry.Dispatch(context.Background(), Identity{UserID: "user-1"}, "starNag.unsubscribe", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	m, ok := result.(map[string]bool)
	if !ok || !m["unsubscribed"] {
		t.Errorf("expected {unsubscribed: true}, got %+v", result)
	}
}
