package wscompat

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/emptypb"
	"google.golang.org/protobuf/types/known/timestamppb"

	infrafleetv1 "github.com/stablyai/orca-go/proto/gen/go/orca/infrafleet/v1"
)

// TestConnectivityGetSummaryChannel_UserIDComesFromIdentityNotArgs mirrors
// TestWorkflowExecuteAdHocStepChannel_TenantIDComesFromIdentityNotArgs's
// pattern (channels_workflow_test.go) for the same regression class:
// GetFleetConnectivitySummaryRequest is deliberately empty (no tenantId/
// userId field to smuggle a forged value through at all), so the guard here
// is that scoping travels only via AttachIdentity's outgoing gRPC metadata,
// never via any caller-supplied arg — even one shaped like a real request
// field name.
func TestConnectivityGetSummaryChannel_UserIDComesFromIdentityNotArgs(t *testing.T) {
	fake := &fakeInfraFleetClient{
		getFleetConnectivitySummaryFunc: func(ctx context.Context, in *infrafleetv1.GetFleetConnectivitySummaryRequest) (*infrafleetv1.GetFleetConnectivitySummaryResponse, error) {
			return &infrafleetv1.GetFleetConnectivitySummaryResponse{}, nil
		},
	}

	r := NewRegistry()
	registerInfraFleetChannels(r, fake)

	// A forged tenantId/userId in args must be ignored entirely — the
	// handler signature doesn't even look at args (`_ []json.RawMessage`),
	// but this locks in that contract against a future edit that starts
	// reading them.
	args := argsJSON(t, map[string]any{"tenantId": "attacker-tenant", "userId": "attacker-user"})
	_, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-real", UserID: "user-real"}, "connectivity.getSummary", args)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	tenant, user := outgoingTenantUser(fake.lastGetFleetConnectivitySummaryCtx)
	if tenant != "tenant-real" {
		t.Errorf("want TenantID from Identity (tenant-real), got %q", tenant)
	}
	if user != "user-real" {
		t.Errorf("want UserID from Identity (user-real), got %q", user)
	}
}

// TestConnectivityGetSummaryChannel_ReturnsCamelCaseFields asserts the JSON
// wire shape uses camelCase keys (connectionId, devServerId, ...), not the
// snake_case protoc-gen-go's own `encoding/json` tags would produce if the
// raw proto message were returned directly — the bug class documented at
// the top of channels_infra_fleet.go.
func TestConnectivityGetSummaryChannel_ReturnsCamelCaseFields(t *testing.T) {
	lastActivity := time.UnixMilli(1_700_000_000_000)
	degradedSince := time.UnixMilli(1_700_000_500_000)
	fake := &fakeInfraFleetClient{
		getFleetConnectivitySummaryFunc: func(ctx context.Context, in *infrafleetv1.GetFleetConnectivitySummaryRequest) (*infrafleetv1.GetFleetConnectivitySummaryResponse, error) {
			return &infrafleetv1.GetFleetConnectivitySummaryResponse{
				Connections: []*infrafleetv1.ConnectionHealthEntry{
					{
						ConnectionId:   "conn-1",
						DevServerId:    "dev-1",
						Status:         "degraded",
						LastActivityAt: timestamppb.New(lastActivity),
						DegradedSince:  timestamppb.New(degradedSince),
					},
				},
			}, nil
		},
	}

	r := NewRegistry()
	registerInfraFleetChannels(r, fake)

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1", UserID: "user-1"}, "connectivity.getSummary", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	raw, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("marshaling result: %v", err)
	}

	var decoded struct {
		Connections []map[string]json.RawMessage `json:"connections"`
	}
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("unmarshaling result JSON: %v (raw: %s)", err, raw)
	}
	if len(decoded.Connections) != 1 {
		t.Fatalf("want 1 connection, got %d (raw: %s)", len(decoded.Connections), raw)
	}
	entry := decoded.Connections[0]
	for _, key := range []string{"connectionId", "devServerId", "status", "lastActivityAt", "degradedSince"} {
		if _, ok := entry[key]; !ok {
			t.Errorf("want camelCase key %q present in %s", key, raw)
		}
	}
	for _, badKey := range []string{"connection_id", "dev_server_id", "last_activity_at", "degraded_since"} {
		if _, ok := entry[badKey]; ok {
			t.Errorf("want snake_case key %q absent, found in %s", badKey, raw)
		}
	}
}

// TestConnectivityGetSummaryChannel_EmptyReturnsEmptyArrayNotNull mirrors
// the established "empty list channels return [] not null" convention
// (e.g. toDepartmentView's call site in channels_tenant_project.go) — a nil
// proto Connections slice must still marshal to `[]`, never `null`, so
// frontend code that does `.map`/`.length` on it doesn't need a null guard.
func TestConnectivityGetSummaryChannel_EmptyReturnsEmptyArrayNotNull(t *testing.T) {
	fake := &fakeInfraFleetClient{
		getFleetConnectivitySummaryFunc: func(ctx context.Context, in *infrafleetv1.GetFleetConnectivitySummaryRequest) (*infrafleetv1.GetFleetConnectivitySummaryResponse, error) {
			return &infrafleetv1.GetFleetConnectivitySummaryResponse{Connections: nil}, nil
		},
	}

	r := NewRegistry()
	registerInfraFleetChannels(r, fake)

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1", UserID: "user-1"}, "connectivity.getSummary", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	raw, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("marshaling result: %v", err)
	}

	var decoded struct {
		Connections json.RawMessage `json:"connections"`
	}
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("unmarshaling result JSON: %v (raw: %s)", err, raw)
	}
	if string(decoded.Connections) != "[]" {
		t.Errorf("want connections to marshal to [] not null, got %s (full: %s)", decoded.Connections, raw)
	}
}

// TestConnectionTeardownChannel_UserIDComesFromIdentityNotArgs mirrors
// TestConnectivityGetSummaryChannel_UserIDComesFromIdentityNotArgs's
// pattern — TeardownConnectionRequest's own proto doc comment says tenant
// scoping comes from the authenticated context, never from a request
// field, so this locks in that AttachIdentity (not a forged args value)
// is what actually reaches the outgoing gRPC metadata.
func TestConnectionTeardownChannel_UserIDComesFromIdentityNotArgs(t *testing.T) {
	fake := &fakeInfraFleetClient{}

	r := NewRegistry()
	registerInfraFleetChannels(r, fake)

	args := argsJSON(t, map[string]any{
		"connectionId": "conn-1",
		"tenantId":     "attacker-tenant",
		"userId":       "attacker-user",
	})
	_, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-real", UserID: "user-real"}, "connection.teardown", args)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	tenant, user := outgoingTenantUser(fake.lastTeardownConnectionCtx)
	if tenant != "tenant-real" {
		t.Errorf("want TenantID from Identity (tenant-real), got %q", tenant)
	}
	if user != "user-real" {
		t.Errorf("want UserID from Identity (user-real), got %q", user)
	}
}

// TestConnectionTeardownChannel_ForwardsConnectionId confirms the only
// caller-supplied field that matters (connectionId) reaches
// TeardownConnectionRequest unchanged.
func TestConnectionTeardownChannel_ForwardsConnectionId(t *testing.T) {
	fake := &fakeInfraFleetClient{}

	r := NewRegistry()
	registerInfraFleetChannels(r, fake)

	args := argsJSON(t, map[string]any{"connectionId": "conn-42"})
	result, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1", UserID: "user-1"}, "connection.teardown", args)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if fake.lastTeardownConnectionIn.GetConnectionId() != "conn-42" {
		t.Errorf("want connectionId forwarded as conn-42, got %q", fake.lastTeardownConnectionIn.GetConnectionId())
	}

	raw, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("marshaling result: %v", err)
	}
	var decoded struct {
		OK bool `json:"ok"`
	}
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("unmarshaling result JSON: %v (raw: %s)", err, raw)
	}
	if !decoded.OK {
		t.Errorf("want {ok: true}, got %s", raw)
	}
}

// TestConnectionTeardownChannel_MissingConnectionIdReturnsError confirms
// the handler fails fast on an empty connectionId instead of forwarding an
// empty-string request to infra-fleet-service.
func TestConnectionTeardownChannel_MissingConnectionIdReturnsError(t *testing.T) {
	fake := &fakeInfraFleetClient{}

	r := NewRegistry()
	registerInfraFleetChannels(r, fake)

	args := argsJSON(t, map[string]any{"connectionId": ""})
	_, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1", UserID: "user-1"}, "connection.teardown", args)
	if err == nil {
		t.Fatal("want error for missing connectionId, got nil")
	}
	if fake.lastTeardownConnectionIn != nil {
		t.Errorf("want TeardownConnection never called, got called with %+v", fake.lastTeardownConnectionIn)
	}
}

// TestConnectionTeardownChannel_PropagatesUpstreamError confirms an error
// from infra-fleet-service (e.g. unknown connectionId, not-found) surfaces
// to the caller rather than being swallowed into a false {ok: true}.
func TestConnectionTeardownChannel_PropagatesUpstreamError(t *testing.T) {
	fake := &fakeInfraFleetClient{
		teardownConnectionFunc: func(ctx context.Context, in *infrafleetv1.TeardownConnectionRequest) (*emptypb.Empty, error) {
			return nil, status.Error(codes.NotFound, "connection not found")
		},
	}

	r := NewRegistry()
	registerInfraFleetChannels(r, fake)

	args := argsJSON(t, map[string]any{"connectionId": "conn-does-not-exist"})
	_, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1", UserID: "user-1"}, "connection.teardown", args)
	if err == nil {
		t.Fatal("want error propagated from TeardownConnection, got nil")
	}
}
