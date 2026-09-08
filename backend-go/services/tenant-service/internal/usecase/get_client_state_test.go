package usecase

import (
	"context"
	"errors"
	"testing"

	"github.com/stablyai/orca-go/common/apperrors"
)

func TestGetClientState_RequiresTenantContext(t *testing.T) {
	uc := NewGetClientState(newFakeClientStateRepository())

	_, err := uc.Execute(context.Background(), "user-1", ClientStateKindKeybindings)
	if err == nil {
		t.Fatal("expected an error when no tenant is in context")
	}
}

func TestGetClientState_UnknownKindReturnsInvalidArgument(t *testing.T) {
	uc := NewGetClientState(newFakeClientStateRepository())
	ctx := withTenant(context.Background(), "company-1")

	_, err := uc.Execute(ctx, "user-1", ClientStateKind("bogus"))
	assertAppError(t, err, apperrors.KindInvalidArgument)
}

func TestGetClientState_NotFoundReturnsFoundFalse(t *testing.T) {
	uc := NewGetClientState(newFakeClientStateRepository())
	ctx := withTenant(context.Background(), "company-1")

	got, err := uc.Execute(ctx, "user-1", ClientStateKindKeybindings)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Found {
		t.Error("want Found=false for a user who never saved this client state")
	}
}

func TestGetClientState_RepositoryErrorPropagates(t *testing.T) {
	repo := newFakeClientStateRepository()
	repo.getErr = errors.New("boom")
	uc := NewGetClientState(repo)
	ctx := withTenant(context.Background(), "company-1")

	_, err := uc.Execute(ctx, "user-1", ClientStateKindKeybindings)
	if err == nil {
		t.Fatal("expected an error when the repository fails")
	}
}

func TestSetClientState_ThenGet_RoundTrips(t *testing.T) {
	repo := newFakeClientStateRepository()
	setUC := NewSetClientState(repo)
	getUC := NewGetClientState(repo)
	ctx := withTenant(context.Background(), "company-1")

	err := setUC.Execute(ctx, SetClientStateInput{
		UserID: "user-1", Kind: ClientStateKindSettings, StateJSON: `{"theme":"dark"}`,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	got, err := getUC.Execute(ctx, "user-1", ClientStateKindSettings)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !got.Found {
		t.Fatal("want Found=true after saving")
	}
	if got.StateJSON != `{"theme":"dark"}` {
		t.Errorf("want the saved state round-tripped, got %q", got.StateJSON)
	}
}

// TestSetClientState_KindsDoNotCollide guards columnForKind's whitelist:
// saving under one kind must never be visible under a different kind for
// the same user (each kind maps to its own dedicated column).
func TestSetClientState_KindsDoNotCollide(t *testing.T) {
	repo := newFakeClientStateRepository()
	setUC := NewSetClientState(repo)
	getUC := NewGetClientState(repo)
	ctx := withTenant(context.Background(), "company-1")

	if err := setUC.Execute(ctx, SetClientStateInput{UserID: "user-1", Kind: ClientStateKindKeybindings, StateJSON: `{"k":1}`}); err != nil {
		t.Fatalf("set keybindings: %v", err)
	}

	got, err := getUC.Execute(ctx, "user-1", ClientStateKindUILocal)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Found {
		t.Error("expected uiLocal to be unaffected by a keybindings save")
	}
}

func TestSetClientState_RequiresTenantContext(t *testing.T) {
	uc := NewSetClientState(newFakeClientStateRepository())

	err := uc.Execute(context.Background(), SetClientStateInput{UserID: "user-1", Kind: ClientStateKindKeybindings, StateJSON: "{}"})
	if err == nil {
		t.Fatal("expected an error when no tenant is in context")
	}
}

func TestSetClientState_UnknownKindReturnsInvalidArgument(t *testing.T) {
	uc := NewSetClientState(newFakeClientStateRepository())
	ctx := withTenant(context.Background(), "company-1")

	err := uc.Execute(ctx, SetClientStateInput{UserID: "user-1", Kind: ClientStateKind("bogus"), StateJSON: "{}"})
	assertAppError(t, err, apperrors.KindInvalidArgument)
}

func TestSetClientState_RepositoryErrorPropagates(t *testing.T) {
	repo := newFakeClientStateRepository()
	repo.setErr = errors.New("boom")
	uc := NewSetClientState(repo)
	ctx := withTenant(context.Background(), "company-1")

	err := uc.Execute(ctx, SetClientStateInput{UserID: "user-1", Kind: ClientStateKindKeybindings, StateJSON: "{}"})
	if err == nil {
		t.Fatal("expected an error when the repository fails")
	}
}
