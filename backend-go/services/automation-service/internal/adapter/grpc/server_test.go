package grpc

import (
	"context"
	"errors"
	"testing"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/stablyai/orca-go/common/tenant"
	"github.com/stablyai/orca-go/services/automation-service/internal/domain"
	"github.com/stablyai/orca-go/services/automation-service/internal/usecase"

	automationv1 "github.com/stablyai/orca-go/proto/gen/go/orca/automation/v1"
	workflowv1 "github.com/stablyai/orca-go/proto/gen/go/orca/workflow/v1"

	"google.golang.org/protobuf/types/known/wrapperspb"
)

// fakeAutomationRepository is an in-memory usecase.AutomationRepository —
// lets these contract tests exercise the real request -> usecase ->
// response translation in Server without a live Postgres. Server wires
// concrete *usecase.X types (not port interfaces), so "fake the usecase" per
// SOL-033's test plan means faking the port one layer down instead.
type fakeAutomationRepository struct {
	byID map[string]domain.Automation

	updateCalls []domain.Automation
	deleteCalls []struct{ tenantID, id string }
}

func newFakeAutomationRepository() *fakeAutomationRepository {
	return &fakeAutomationRepository{byID: map[string]domain.Automation{}}
}

func (f *fakeAutomationRepository) Create(ctx context.Context, a domain.Automation) error {
	f.byID[a.ID] = a
	return nil
}

func (f *fakeAutomationRepository) Get(ctx context.Context, tenantID, id string) (domain.Automation, error) {
	a, ok := f.byID[id]
	if !ok || a.TenantID != tenantID {
		return domain.Automation{}, errors.New("not found")
	}
	return a, nil
}

func (f *fakeAutomationRepository) List(ctx context.Context, tenantID, pageToken string, pageSize int32) ([]domain.Automation, string, error) {
	var out []domain.Automation
	for _, a := range f.byID {
		if a.TenantID == tenantID {
			out = append(out, a)
		}
	}
	return out, "", nil
}

func (f *fakeAutomationRepository) Update(ctx context.Context, tenantID string, a domain.Automation) error {
	f.updateCalls = append(f.updateCalls, a)
	f.byID[a.ID] = a
	return nil
}

func (f *fakeAutomationRepository) Delete(ctx context.Context, tenantID, id string) error {
	f.deleteCalls = append(f.deleteCalls, struct{ tenantID, id string }{tenantID, id})
	delete(f.byID, id)
	return nil
}

func (f *fakeAutomationRepository) AcquireRunLock(ctx context.Context, tenantID, automationID, runID string, ttl time.Duration) (bool, error) {
	return true, nil
}

func (f *fakeAutomationRepository) ReleaseRunLock(ctx context.Context, tenantID, automationID, runID string) error {
	return nil
}

func newServerForListUpdateDelete(repo *fakeAutomationRepository) *Server {
	return New(nil, nil, nil, nil,
		usecase.NewListAutomations(repo),
		usecase.NewUpdateAutomation(repo),
		usecase.NewDeleteAutomation(repo),
	)
}

func seedGRPCAutomation(t *testing.T, repo *fakeAutomationRepository, tenantID, id string) domain.Automation {
	t.Helper()
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	a, err := domain.NewAutomation(id, tenantID, "nightly-report", "FREQ=DAILY;INTERVAL=1", domain.StepTypeAgent, `{"prompt":"summarize"}`, now, "UTC", true, now)
	if err != nil {
		t.Fatalf("building automation: %v", err)
	}
	_ = repo.Create(context.Background(), a)
	return a
}

func TestServer_ListAutomations_TranslatesRequestAndResponse(t *testing.T) {
	repo := newFakeAutomationRepository()
	seedGRPCAutomation(t, repo, "tenant-1", "auto-1")
	seedGRPCAutomation(t, repo, "tenant-1", "auto-2")
	seedGRPCAutomation(t, repo, "tenant-2", "auto-3")

	s := newServerForListUpdateDelete(repo)
	resp, err := s.ListAutomations(context.Background(), &automationv1.ListAutomationsRequest{TenantId: "tenant-1"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(resp.GetAutomations()) != 2 {
		t.Fatalf("expected 2 automations for tenant-1, got %d", len(resp.GetAutomations()))
	}
	for _, a := range resp.GetAutomations() {
		if a.GetTenantId() != "tenant-1" {
			t.Errorf("expected only tenant-1 automations, got tenant_id=%q", a.GetTenantId())
		}
	}
}

func TestServer_ListAutomations_MissingTenantIDReturnsInvalidArgument(t *testing.T) {
	repo := newFakeAutomationRepository()
	s := newServerForListUpdateDelete(repo)

	_, err := s.ListAutomations(context.Background(), &automationv1.ListAutomationsRequest{})
	if err == nil {
		t.Fatal("expected an error when tenant_id is missing")
	}
	st, ok := status.FromError(err)
	if !ok {
		t.Fatalf("expected a gRPC status error, got %v", err)
	}
	if st.Code() != codes.InvalidArgument {
		t.Errorf("expected InvalidArgument, got %v", st.Code())
	}
}

func TestServer_UpdateAutomation_UnsetWrapperFieldsLeaveOtherFieldsUnchanged(t *testing.T) {
	repo := newFakeAutomationRepository()
	seedGRPCAutomation(t, repo, "tenant-1", "auto-1")

	s := newServerForListUpdateDelete(repo)

	// Only "enabled" is set on the wire request — the regression guard: a
	// caller toggling one field must not zero-value-overwrite name/rrule/etc.
	resp, err := s.UpdateAutomation(context.Background(), &automationv1.UpdateAutomationRequest{
		Id:       "auto-1",
		TenantId: "tenant-1",
		Enabled:  wrapperspb.Bool(false),
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.GetAutomation().GetEnabled() {
		t.Error("expected enabled=false to be applied")
	}
	if resp.GetAutomation().GetName() != "nightly-report" {
		t.Errorf("expected name to remain unchanged, got %q", resp.GetAutomation().GetName())
	}
	if resp.GetAutomation().GetRrule() != "FREQ=DAILY;INTERVAL=1" {
		t.Errorf("expected rrule to remain unchanged, got %q", resp.GetAutomation().GetRrule())
	}

	if len(repo.updateCalls) != 1 {
		t.Fatalf("expected exactly 1 Update call, got %d", len(repo.updateCalls))
	}
	if repo.updateCalls[0].Name != "nightly-report" {
		t.Errorf("expected the persisted automation to keep its original name, got %q", repo.updateCalls[0].Name)
	}
}

func TestServer_UpdateAutomation_AppliesEveryWrapperField(t *testing.T) {
	repo := newFakeAutomationRepository()
	seedGRPCAutomation(t, repo, "tenant-1", "auto-1")

	s := newServerForListUpdateDelete(repo)
	resp, err := s.UpdateAutomation(context.Background(), &automationv1.UpdateAutomationRequest{
		Id:             "auto-1",
		TenantId:       "tenant-1",
		Name:           wrapperspb.String("renamed"),
		Rrule:          wrapperspb.String("FREQ=WEEKLY"),
		StepConfigJson: wrapperspb.String(`{"prompt":"new"}`),
		StepType:       workflowv1.StepType_STEP_TYPE_SHELL,
		Enabled:        wrapperspb.Bool(false),
		Timezone:       wrapperspb.String("Asia/Ho_Chi_Minh"),
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	a := resp.GetAutomation()
	if a.GetName() != "renamed" {
		t.Errorf("expected name=renamed, got %q", a.GetName())
	}
	if a.GetRrule() != "FREQ=WEEKLY" {
		t.Errorf("expected rrule=FREQ=WEEKLY, got %q", a.GetRrule())
	}
	if a.GetStepConfigJson() != `{"prompt":"new"}` {
		t.Errorf("expected step_config_json updated, got %q", a.GetStepConfigJson())
	}
	if a.GetStepType() != workflowv1.StepType_STEP_TYPE_SHELL {
		t.Errorf("expected step_type=shell, got %v", a.GetStepType())
	}
	if a.GetEnabled() {
		t.Error("expected enabled=false")
	}
	if a.GetTimezone() != "Asia/Ho_Chi_Minh" {
		t.Errorf("expected timezone updated, got %q", a.GetTimezone())
	}
}

func TestServer_UpdateAutomation_InvalidDtstartReturnsInvalidArgument(t *testing.T) {
	repo := newFakeAutomationRepository()
	seedGRPCAutomation(t, repo, "tenant-1", "auto-1")

	s := newServerForListUpdateDelete(repo)
	_, err := s.UpdateAutomation(context.Background(), &automationv1.UpdateAutomationRequest{
		Id:       "auto-1",
		TenantId: "tenant-1",
		Dtstart:  wrapperspb.String("not-a-date"),
	})
	if err == nil {
		t.Fatal("expected an error for a malformed dtstart")
	}
	st, ok := status.FromError(err)
	if !ok {
		t.Fatalf("expected a gRPC status error, got %v", err)
	}
	if st.Code() != codes.InvalidArgument {
		t.Errorf("expected InvalidArgument, got %v", st.Code())
	}
}

func TestServer_UpdateAutomation_NotFoundReturnsNotFound(t *testing.T) {
	repo := newFakeAutomationRepository()
	s := newServerForListUpdateDelete(repo)

	_, err := s.UpdateAutomation(context.Background(), &automationv1.UpdateAutomationRequest{Id: "missing", TenantId: "tenant-1"})
	if err == nil {
		t.Fatal("expected an error for a missing automation")
	}
	st, ok := status.FromError(err)
	if !ok {
		t.Fatalf("expected a gRPC status error, got %v", err)
	}
	if st.Code() != codes.NotFound {
		t.Errorf("expected NotFound, got %v", st.Code())
	}
}

func TestServer_DeleteAutomation_CallsRepositoryWithTenantAndID(t *testing.T) {
	repo := newFakeAutomationRepository()
	seedGRPCAutomation(t, repo, "tenant-1", "auto-1")

	s := newServerForListUpdateDelete(repo)
	_, err := s.DeleteAutomation(context.Background(), &automationv1.DeleteAutomationRequest{Id: "auto-1", TenantId: "tenant-1"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(repo.deleteCalls) != 1 {
		t.Fatalf("expected exactly 1 Delete call, got %d", len(repo.deleteCalls))
	}
	if repo.deleteCalls[0].tenantID != "tenant-1" || repo.deleteCalls[0].id != "auto-1" {
		t.Errorf("expected Delete(tenant-1, auto-1), got Delete(%q, %q)", repo.deleteCalls[0].tenantID, repo.deleteCalls[0].id)
	}
	if _, ok := repo.byID["auto-1"]; ok {
		t.Error("expected the automation to be removed")
	}
}

// CR-AUTO-002/TASK-BE-AUTO-005

func TestServer_CreateAutomation_ActionsRoundTripThroughProto(t *testing.T) {
	repo := newFakeAutomationRepository()
	s := New(usecase.NewCreateAutomation(repo), nil, nil, nil, nil, nil, nil)
	ctx := tenant.WithTenantID(context.Background(), "tenant-1")

	resp, err := s.CreateAutomation(ctx, &automationv1.CreateAutomationRequest{
		Name:  "review-and-pr",
		Rrule: "FREQ=DAILY;INTERVAL=1",
		Actions: []*automationv1.AutomationAction{
			{Id: "a1", Type: automationv1.AutomationActionType_AUTOMATION_ACTION_TYPE_RUN_AGENT, ConfigJson: `{"prompt":"review"}`},
			{Id: "a2", Type: automationv1.AutomationActionType_AUTOMATION_ACTION_TYPE_CREATE_PR, ConfigJson: `{"title":"x"}`, ContinueOnFailure: true},
		},
		MaxRunHistory: 50,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	got := resp.GetAutomation()
	if len(got.GetActions()) != 2 {
		t.Fatalf("expected 2 actions in the response, got %+v", got.GetActions())
	}
	if got.GetActions()[1].GetType() != automationv1.AutomationActionType_AUTOMATION_ACTION_TYPE_CREATE_PR || !got.GetActions()[1].GetContinueOnFailure() {
		t.Errorf("action[1] not round-tripped correctly: %+v", got.GetActions()[1])
	}
	if got.GetMaxRunHistory() != 50 {
		t.Errorf("MaxRunHistory = %d, want 50", got.GetMaxRunHistory())
	}
}

func TestServer_UpdateAutomation_NilActionsSet_LeavesChainUnchanged(t *testing.T) {
	repo := newFakeAutomationRepository()
	automation := seedGRPCAutomation(t, repo, "tenant-1", "auto-1")
	automation.Actions = []domain.AutomationAction{{ID: "a1", Type: domain.AutomationActionTypeRunAgent, ConfigJSON: `{}`}}
	_ = repo.Update(context.Background(), "tenant-1", automation)

	s := newServerForListUpdateDelete(repo)
	resp, err := s.UpdateAutomation(context.Background(), &automationv1.UpdateAutomationRequest{
		Id: "auto-1", TenantId: "tenant-1",
		// ActionsSet deliberately not set.
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(resp.GetAutomation().GetActions()) != 1 {
		t.Fatalf("expected the existing action to survive, got %+v", resp.GetAutomation().GetActions())
	}
}

func TestServer_UpdateAutomation_EmptyActionsSet_ClearsChain(t *testing.T) {
	repo := newFakeAutomationRepository()
	automation := seedGRPCAutomation(t, repo, "tenant-1", "auto-1")
	automation.Actions = []domain.AutomationAction{{ID: "a1", Type: domain.AutomationActionTypeRunAgent, ConfigJSON: `{}`}}
	_ = repo.Update(context.Background(), "tenant-1", automation)

	s := newServerForListUpdateDelete(repo)
	resp, err := s.UpdateAutomation(context.Background(), &automationv1.UpdateAutomationRequest{
		Id: "auto-1", TenantId: "tenant-1",
		ActionsSet: &automationv1.AutomationActionList{Actions: nil}, // present, explicitly empty
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(resp.GetAutomation().GetActions()) != 0 {
		t.Fatalf("expected an explicitly-present, empty ActionsSet to clear the chain, got %+v", resp.GetAutomation().GetActions())
	}
}
