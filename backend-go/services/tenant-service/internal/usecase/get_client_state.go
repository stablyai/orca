package usecase

import (
	"context"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/common/tenant"
)

// ClientStateKind identifies which of the 5 opaque per-user JSON blobs a
// clientState.get/set call targets (CR-STORAGE-001/003/004b — keybindings,
// UI local state, saved runtime environments, client settings, accounts->
// dev-server map). A plain string type, not tenantv1.ClientStateKind:
// usecase never imports proto/gen/go (see every other file in this
// package) — adapter/grpc is responsible for translating the wire enum
// into this type, same "no business logic in the adapter, but wire
// translation is fine" split as every other handler in server.go.
type ClientStateKind string

const (
	ClientStateKindKeybindings              ClientStateKind = "keybindings"
	ClientStateKindUILocal                  ClientStateKind = "uiLocal"
	ClientStateKindSavedRuntimeEnvironments ClientStateKind = "savedRuntimeEnvironments"
	ClientStateKindSettings                 ClientStateKind = "settings"
	ClientStateKindAccountsDevServerMap     ClientStateKind = "accountsDevServerMap"
)

// columnForKind is the ONLY place a ClientStateKind is turned into a
// storage column name — mirrors adapter/postgres's own columnNameFor
// whitelist switch (defense in depth: an unknown kind is rejected here,
// before it ever reaches the repository).
func columnForKind(kind ClientStateKind) (string, bool) {
	switch kind {
	case ClientStateKindKeybindings:
		return "keybindings_json", true
	case ClientStateKindUILocal:
		return "ui_local_state_json", true
	case ClientStateKindSavedRuntimeEnvironments:
		return "saved_runtime_environments_json", true
	case ClientStateKindSettings:
		return "client_settings_json", true
	case ClientStateKindAccountsDevServerMap:
		return "accounts_dev_server_json", true
	default:
		return "", false
	}
}

type GetClientState struct {
	repo ClientStateRepository
}

func NewGetClientState(repo ClientStateRepository) *GetClientState {
	return &GetClientState{repo: repo}
}

// GetClientStateResult's Found distinguishes "never saved" from a real,
// possibly empty-but-saved value — same shape as GetOnboardingStateResult.
type GetClientStateResult struct {
	StateJSON string
	Found     bool
}

func (uc *GetClientState) Execute(ctx context.Context, userID string, kind ClientStateKind) (GetClientStateResult, error) {
	companyID, err := tenant.RequireTenantID(ctx)
	if err != nil {
		return GetClientStateResult{}, apperrors.New(apperrors.KindUnauthenticated, "TENANT_NO_TENANT", "no tenant in request context", err)
	}
	column, ok := columnForKind(kind)
	if !ok {
		return GetClientStateResult{}, apperrors.New(apperrors.KindInvalidArgument, "TENANT_UNKNOWN_CLIENT_STATE_KIND", "unknown client state kind", nil)
	}
	stateJSON, found, err := uc.repo.GetClientStateColumn(ctx, companyID, userID, column)
	if err != nil {
		return GetClientStateResult{}, apperrors.New(apperrors.KindInternal, "TENANT_GET_CLIENT_STATE_FAILED", "failed to load client state", err)
	}
	return GetClientStateResult{StateJSON: stateJSON, Found: found}, nil
}
