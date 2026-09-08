package domain

import (
	"testing"
	"time"
)

func TestTranslateEvent_KnownSubjectMapsToRule(t *testing.T) {
	now := time.Now()
	payload := EventPayload{UserID: "user-1"}

	got, err := TranslateEvent("ne-1", "evt-1", "orca.task.task.completed", "tenant-1", payload, now)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Type != "task_completed" {
		t.Errorf("expected type task_completed, got %s", got.Type)
	}
	if got.Severity != SeverityInfo {
		t.Errorf("expected severity info, got %s", got.Severity)
	}
	if len(got.RecipientUserIDs) != 1 || got.RecipientUserIDs[0] != "user-1" {
		t.Errorf("expected recipients [user-1], got %v", got.RecipientUserIDs)
	}
	if got.TenantID != "tenant-1" || got.SourceEventID != "evt-1" || got.SourceSubject != "orca.task.task.completed" {
		t.Errorf("expected envelope fields to carry through, got %+v", got)
	}
}

func TestTranslateEvent_CredentialRotatedIsCritical(t *testing.T) {
	got, err := TranslateEvent("ne-1", "evt-1", "orca.credential.credential.rotated", "tenant-1", EventPayload{UserID: "user-1"}, time.Now())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Severity != SeverityCritical {
		t.Errorf("expected credential rotation to be critical severity, got %s", got.Severity)
	}
}

func TestTranslateEvent_StarNagVisibilityChangedPassesBodyThroughUnchanged(t *testing.T) {
	// TASK-014: tenant-service's starNagVisibilityBody JSON triple
	// ({event,mode,surface}) rides in payload.Body unchanged — the
	// subjectRule's own Body is deliberately "".
	rawBody := `{"event":"show","mode":"gh","surface":"card"}`
	payload := EventPayload{UserID: "user-1", Body: rawBody}
	got, err := TranslateEvent("ne-1", "evt-1", "orca.tenant.star_nag.visibility_changed", "tenant-1", payload, time.Now())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Type != "star_nag_visibility" {
		t.Errorf("expected type star_nag_visibility, got %s", got.Type)
	}
	if got.Body != rawBody {
		t.Errorf("expected payload.Body to pass through unchanged, got %q", got.Body)
	}
	if len(got.Channels) != 1 || got.Channels[0] != ChannelDeliveryWS {
		t.Errorf("expected WS-only delivery, got %v", got.Channels)
	}
}

func TestTranslateEvent_UnknownSubjectFallsBackToGenericRule(t *testing.T) {
	got, err := TranslateEvent("ne-1", "evt-1", "orca.some-new-service.thing.happened", "tenant-1", EventPayload{UserID: "user-1"}, time.Now())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Type != "generic" {
		t.Errorf("expected generic fallback type, got %s", got.Type)
	}
	if len(got.Channels) != 1 || got.Channels[0] != ChannelDeliveryWS {
		t.Errorf("expected fallback to be WS-only, got %v", got.Channels)
	}
}

func TestTranslateEvent_PayloadOverridesTitleAndBody(t *testing.T) {
	payload := EventPayload{UserID: "user-1", Title: "Custom title", Body: "Custom body", DeepLink: "/tasks/42"}
	got, err := TranslateEvent("ne-1", "evt-1", "orca.task.task.completed", "tenant-1", payload, time.Now())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Title != "Custom title" || got.Body != "Custom body" || got.DeepLink != "/tasks/42" {
		t.Errorf("expected payload overrides to win, got %+v", got)
	}
}

func TestTranslateEvent_MultipleRecipients(t *testing.T) {
	payload := EventPayload{UserIDs: []string{"user-1", "user-2"}}
	got, err := TranslateEvent("ne-1", "evt-1", "orca.task.task.completed", "tenant-1", payload, time.Now())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got.RecipientUserIDs) != 2 {
		t.Errorf("expected 2 recipients, got %v", got.RecipientUserIDs)
	}
}

func TestTranslateEvent_NoRecipientsReturnsError(t *testing.T) {
	_, err := TranslateEvent("ne-1", "evt-1", "orca.task.task.completed", "tenant-1", EventPayload{}, time.Now())
	if err != ErrNoRecipients {
		t.Fatalf("expected ErrNoRecipients, got %v", err)
	}
}

func TestDecodePayload(t *testing.T) {
	t.Run("empty payload", func(t *testing.T) {
		got, err := DecodePayload(nil)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got.UserID != "" || len(got.UserIDs) != 0 || got.Title != "" || got.Body != "" || got.DeepLink != "" {
			t.Errorf("expected zero-value payload, got %+v", got)
		}
	})

	t.Run("valid json", func(t *testing.T) {
		got, err := DecodePayload([]byte(`{"user_id":"user-1","title":"hi"}`))
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got.UserID != "user-1" || got.Title != "hi" {
			t.Errorf("unexpected decode result: %+v", got)
		}
	})

	t.Run("malformed json", func(t *testing.T) {
		if _, err := DecodePayload([]byte(`not-json`)); err == nil {
			t.Fatal("expected an error decoding malformed json")
		}
	})
}
