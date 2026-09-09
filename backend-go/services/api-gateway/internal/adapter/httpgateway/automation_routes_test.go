package httpgateway

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/emptypb"

	"github.com/stablyai/orca-go/services/api-gateway/internal/usecase"

	automationv1 "github.com/stablyai/orca-go/proto/gen/go/orca/automation/v1"
	workflowv1 "github.com/stablyai/orca-go/proto/gen/go/orca/workflow/v1"
)

// fakeAutomationServiceClient implements automationv1.AutomationServiceClient
// (the methods this REST-route layer's tests exercise) entirely in-memory,
// configurable to return either a canned response or a gRPC status error per
// method, and records the last request/context it saw so tests can assert
// on what mountAutomationRoutes actually sent upstream. The embedded (nil)
// interface satisfies every OTHER AutomationServiceClient method added
// since this fake was written (e.g. TASK-218's List/Update/Delete) without
// needing a hook for each — those RPCs aren't exercised by
// automation_routes.go's REST handlers, so a panic-on-call default is
// correct: it would mean this file started calling one of them and needs a
// real hook added.
type fakeAutomationServiceClient struct {
	automationv1.AutomationServiceClient

	createAutomationResp *automationv1.CreateAutomationResponse
	createAutomationErr  error
	lastCreateReq        *automationv1.CreateAutomationRequest

	runNowResp    *automationv1.RunNowResponse
	runNowErr     error
	lastRunNowReq *automationv1.RunNowRequest

	listRunsResp    *automationv1.ListRunsResponse
	listRunsErr     error
	lastListRunsReq *automationv1.ListRunsRequest

	handleExternalTriggerResp    *automationv1.HandleExternalTriggerResponse
	handleExternalTriggerErr     error
	lastHandleExternalTriggerReq *automationv1.HandleExternalTriggerRequest

	// TASK-BE-AUTO-012
	listAutomationsResp    *automationv1.ListAutomationsResponse
	listAutomationsErr     error
	lastListAutomationsReq *automationv1.ListAutomationsRequest

	updateAutomationResp    *automationv1.UpdateAutomationResponse
	updateAutomationErr     error
	lastUpdateAutomationReq *automationv1.UpdateAutomationRequest

	deleteAutomationErr     error
	lastDeleteAutomationReq *automationv1.DeleteAutomationRequest

	lastCtx context.Context
}

func (f *fakeAutomationServiceClient) CreateAutomation(ctx context.Context, in *automationv1.CreateAutomationRequest, _ ...grpc.CallOption) (*automationv1.CreateAutomationResponse, error) {
	f.lastCtx = ctx
	f.lastCreateReq = in
	if f.createAutomationErr != nil {
		return nil, f.createAutomationErr
	}
	return f.createAutomationResp, nil
}

func (f *fakeAutomationServiceClient) RunNow(ctx context.Context, in *automationv1.RunNowRequest, _ ...grpc.CallOption) (*automationv1.RunNowResponse, error) {
	f.lastCtx = ctx
	f.lastRunNowReq = in
	if f.runNowErr != nil {
		return nil, f.runNowErr
	}
	return f.runNowResp, nil
}

func (f *fakeAutomationServiceClient) ListRuns(ctx context.Context, in *automationv1.ListRunsRequest, _ ...grpc.CallOption) (*automationv1.ListRunsResponse, error) {
	f.lastCtx = ctx
	f.lastListRunsReq = in
	if f.listRunsErr != nil {
		return nil, f.listRunsErr
	}
	return f.listRunsResp, nil
}

func (f *fakeAutomationServiceClient) HandleExternalTrigger(ctx context.Context, in *automationv1.HandleExternalTriggerRequest, _ ...grpc.CallOption) (*automationv1.HandleExternalTriggerResponse, error) {
	f.lastCtx = ctx
	f.lastHandleExternalTriggerReq = in
	if f.handleExternalTriggerErr != nil {
		return nil, f.handleExternalTriggerErr
	}
	return f.handleExternalTriggerResp, nil
}

// TASK-BE-AUTO-012
func (f *fakeAutomationServiceClient) ListAutomations(ctx context.Context, in *automationv1.ListAutomationsRequest, _ ...grpc.CallOption) (*automationv1.ListAutomationsResponse, error) {
	f.lastCtx = ctx
	f.lastListAutomationsReq = in
	if f.listAutomationsErr != nil {
		return nil, f.listAutomationsErr
	}
	return f.listAutomationsResp, nil
}

func (f *fakeAutomationServiceClient) UpdateAutomation(ctx context.Context, in *automationv1.UpdateAutomationRequest, _ ...grpc.CallOption) (*automationv1.UpdateAutomationResponse, error) {
	f.lastCtx = ctx
	f.lastUpdateAutomationReq = in
	if f.updateAutomationErr != nil {
		return nil, f.updateAutomationErr
	}
	return f.updateAutomationResp, nil
}

func (f *fakeAutomationServiceClient) DeleteAutomation(ctx context.Context, in *automationv1.DeleteAutomationRequest, _ ...grpc.CallOption) (*emptypb.Empty, error) {
	f.lastCtx = ctx
	f.lastDeleteAutomationReq = in
	if f.deleteAutomationErr != nil {
		return nil, f.deleteAutomationErr
	}
	return &emptypb.Empty{}, nil
}

// testAutomationRouter mounts mountAutomationRoutes alone on a fresh chi
// router — no auth middleware — since these tests inject identity directly
// into the request context, the same way authMiddleware would have.
func testAutomationRouter(client automationv1.AutomationServiceClient) http.Handler {
	r := chi.NewRouter()
	mountAutomationRoutes(r, client)
	return r
}

func requestWithIdentity(method, path string, body []byte, identity usecase.Identity) *http.Request {
	var r *http.Request
	if body != nil {
		r = httptest.NewRequest(method, path, bytes.NewReader(body))
	} else {
		r = httptest.NewRequest(method, path, nil)
	}
	return r.WithContext(withIdentity(r.Context(), identity))
}

func TestHandleCreateAutomation_SuccessRoundTrip(t *testing.T) {
	client := &fakeAutomationServiceClient{
		createAutomationResp: &automationv1.CreateAutomationResponse{
			Automation: &automationv1.Automation{
				Id:       "auto-1",
				TenantId: "tenant-1",
				Name:     "nightly backup",
			},
		},
	}
	router := testAutomationRouter(client)

	body, _ := json.Marshal(createAutomationRequestBody{
		Name:           "nightly backup",
		RRule:          "FREQ=DAILY",
		StepConfigJSON: `{"cmd":"true"}`,
		StepType:       "shell",
	})
	req := requestWithIdentity(http.MethodPost, "/v1/automations/", body, usecase.Identity{TenantID: "tenant-1", UserID: "user-1"})
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusCreated, rec.Body.String())
	}

	var got automationv1.Automation
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("unmarshal response: %v; body=%s", err, rec.Body.String())
	}
	if got.Id != "auto-1" || got.Name != "nightly backup" {
		t.Fatalf("unexpected response: id=%q name=%q", got.Id, got.Name)
	}

	if client.lastCreateReq == nil {
		t.Fatal("expected CreateAutomation to be called")
	}
	if client.lastCreateReq.StepType != workflowv1.StepType_STEP_TYPE_SHELL {
		t.Fatalf("StepType = %v, want %v", client.lastCreateReq.StepType, workflowv1.StepType_STEP_TYPE_SHELL)
	}
	if client.lastCreateReq.TenantId != "tenant-1" {
		t.Fatalf("TenantId = %q, want %q", client.lastCreateReq.TenantId, "tenant-1")
	}
}

func TestHandleCreateAutomation_TenantIDComesFromIdentityNotBody(t *testing.T) {
	client := &fakeAutomationServiceClient{
		createAutomationResp: &automationv1.CreateAutomationResponse{
			Automation: &automationv1.Automation{Id: "auto-2"},
		},
	}
	router := testAutomationRouter(client)

	// The request body carries no tenant_id field at all (the wire type
	// intentionally has none) — but craft a raw JSON body with an attempted
	// tenant_id key to prove it's ignored even if a client tries to smuggle
	// one in.
	rawBody := []byte(`{"name":"n","rrule":"FREQ=DAILY","tenant_id":"attacker-tenant"}`)
	req := requestWithIdentity(http.MethodPost, "/v1/automations/", rawBody, usecase.Identity{TenantID: "real-tenant", UserID: "user-1"})
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusCreated, rec.Body.String())
	}
	if client.lastCreateReq == nil {
		t.Fatal("expected CreateAutomation to be called")
	}
	if client.lastCreateReq.TenantId != "real-tenant" {
		t.Fatalf("TenantId = %q, want %q (must come from identity, not body)", client.lastCreateReq.TenantId, "real-tenant")
	}
}

func TestHandleRunNow_GRPCErrorMapsToHTTPStatus(t *testing.T) {
	client := &fakeAutomationServiceClient{
		runNowErr: status.Error(codes.NotFound, "automation not found"),
	}
	router := testAutomationRouter(client)

	req := requestWithIdentity(http.MethodPost, "/v1/automations/auto-404/run", []byte(`{}`), usecase.Identity{TenantID: "tenant-1", UserID: "user-1"})
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusNotFound, rec.Body.String())
	}

	var body errorBody
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal error body: %v; body=%s", err, rec.Body.String())
	}
	if body.Error.Code != codes.NotFound.String() {
		t.Fatalf("error.code = %q, want %q", body.Error.Code, codes.NotFound.String())
	}
	if body.Error.Message != "automation not found" {
		t.Fatalf("error.message = %q, want %q", body.Error.Message, "automation not found")
	}

	if client.lastRunNowReq == nil || client.lastRunNowReq.AutomationId != "auto-404" {
		t.Fatalf("expected RunNow called with automation id auto-404, got %+v", client.lastRunNowReq)
	}
}

func TestHandleListRuns_SuccessRoundTrip(t *testing.T) {
	client := &fakeAutomationServiceClient{
		listRunsResp: &automationv1.ListRunsResponse{
			Runs: []*automationv1.AutomationRun{
				{Id: "run-1", AutomationId: "auto-1", Status: "completed"},
			},
			NextPageToken: "next",
		},
	}
	router := testAutomationRouter(client)

	req := requestWithIdentity(http.MethodGet, "/v1/automations/auto-1/runs?page_size=10", nil, usecase.Identity{TenantID: "tenant-1", UserID: "user-1"})
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	if client.lastListRunsReq == nil || client.lastListRunsReq.AutomationId != "auto-1" || client.lastListRunsReq.PageSize != 10 {
		t.Fatalf("unexpected ListRuns request: %+v", client.lastListRunsReq)
	}
}

func TestHandleHandleExternalTrigger_SuccessRoundTrip(t *testing.T) {
	client := &fakeAutomationServiceClient{
		handleExternalTriggerResp: &automationv1.HandleExternalTriggerResponse{
			Run: &automationv1.AutomationRun{Id: "run-2", AutomationId: "auto-1", Status: "running"},
		},
	}
	router := testAutomationRouter(client)

	body, _ := json.Marshal(handleExternalTriggerRequestBody{
		RequestID:   "ext-req-1",
		PayloadJSON: `{"foo":"bar"}`,
	})
	req := requestWithIdentity(http.MethodPost, "/v1/automations/auto-1/trigger", body, usecase.Identity{TenantID: "tenant-1", UserID: "user-1"})
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	if client.lastHandleExternalTriggerReq == nil || client.lastHandleExternalTriggerReq.AutomationId != "auto-1" || client.lastHandleExternalTriggerReq.RequestId != "ext-req-1" {
		t.Fatalf("unexpected HandleExternalTrigger request: %+v", client.lastHandleExternalTriggerReq)
	}
}

// TASK-BE-AUTO-012

func TestHandleListAutomations_SuccessRoundTrip(t *testing.T) {
	client := &fakeAutomationServiceClient{
		listAutomationsResp: &automationv1.ListAutomationsResponse{
			Automations: []*automationv1.Automation{
				{Id: "auto-1", TenantId: "tenant-1", Name: "nightly backup"},
			},
			NextPageToken: "next",
		},
	}
	router := testAutomationRouter(client)

	req := requestWithIdentity(http.MethodGet, "/v1/automations/?page_size=10&page_token=abc", nil, usecase.Identity{TenantID: "tenant-1", UserID: "user-1"})
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	if client.lastListAutomationsReq == nil {
		t.Fatal("expected ListAutomations to be called")
	}
	if client.lastListAutomationsReq.TenantId != "tenant-1" {
		t.Fatalf("TenantId = %q, want %q (must come from identity, not query param)", client.lastListAutomationsReq.TenantId, "tenant-1")
	}
	if client.lastListAutomationsReq.PageSize != 10 || client.lastListAutomationsReq.PageToken != "abc" {
		t.Fatalf("unexpected ListAutomations request: %+v", client.lastListAutomationsReq)
	}

	var got automationv1.ListAutomationsResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("unmarshal response: %v; body=%s", err, rec.Body.String())
	}
	if len(got.Automations) != 1 || got.Automations[0].Id != "auto-1" {
		t.Fatalf("unexpected response body: %+v", &got)
	}
}

func TestHandleUpdateAutomation_PartialEditOnlySetsProvidedFields(t *testing.T) {
	client := &fakeAutomationServiceClient{
		updateAutomationResp: &automationv1.UpdateAutomationResponse{
			Automation: &automationv1.Automation{Id: "auto-1", Enabled: false},
		},
	}
	router := testAutomationRouter(client)

	// Only "enabled" is present — every other field must arrive as a nil
	// wrapper (== "no change"), not an empty StringValue (== "clear this
	// field"). This is the whole reason UpdateAutomationRequest uses
	// wrapper types instead of full-replace semantics.
	rawBody := []byte(`{"enabled":false}`)
	req := requestWithIdentity(http.MethodPatch, "/v1/automations/auto-1", rawBody, usecase.Identity{TenantID: "tenant-1", UserID: "user-1"})
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	if client.lastUpdateAutomationReq == nil {
		t.Fatal("expected UpdateAutomation to be called")
	}
	if client.lastUpdateAutomationReq.Id != "auto-1" || client.lastUpdateAutomationReq.TenantId != "tenant-1" {
		t.Fatalf("unexpected id/tenant: %+v", client.lastUpdateAutomationReq)
	}
	if client.lastUpdateAutomationReq.Enabled == nil || client.lastUpdateAutomationReq.Enabled.GetValue() != false {
		t.Fatalf("Enabled = %v, want wrapped false", client.lastUpdateAutomationReq.Enabled)
	}
	if client.lastUpdateAutomationReq.Name != nil {
		t.Fatalf("Name = %v, want nil (field not present in request body)", client.lastUpdateAutomationReq.Name)
	}
	if client.lastUpdateAutomationReq.Rrule != nil {
		t.Fatalf("Rrule = %v, want nil (field not present in request body)", client.lastUpdateAutomationReq.Rrule)
	}
}

func TestHandleUpdateAutomation_SetsStepTypeWhenProvided(t *testing.T) {
	client := &fakeAutomationServiceClient{
		updateAutomationResp: &automationv1.UpdateAutomationResponse{
			Automation: &automationv1.Automation{Id: "auto-1"},
		},
	}
	router := testAutomationRouter(client)

	body, _ := json.Marshal(updateAutomationRequestBody{Name: strPtr("renamed"), StepType: strPtr("shell")})
	req := requestWithIdentity(http.MethodPatch, "/v1/automations/auto-1", body, usecase.Identity{TenantID: "tenant-1", UserID: "user-1"})
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	if client.lastUpdateAutomationReq.Name == nil || client.lastUpdateAutomationReq.Name.GetValue() != "renamed" {
		t.Fatalf("Name = %v, want wrapped %q", client.lastUpdateAutomationReq.Name, "renamed")
	}
	if client.lastUpdateAutomationReq.StepType != workflowv1.StepType_STEP_TYPE_SHELL {
		t.Fatalf("StepType = %v, want %v", client.lastUpdateAutomationReq.StepType, workflowv1.StepType_STEP_TYPE_SHELL)
	}
}

func TestHandleDeleteAutomation_SuccessReturnsNoContent(t *testing.T) {
	client := &fakeAutomationServiceClient{}
	router := testAutomationRouter(client)

	req := requestWithIdentity(http.MethodDelete, "/v1/automations/auto-1", nil, usecase.Identity{TenantID: "tenant-1", UserID: "user-1"})
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusNoContent, rec.Body.String())
	}
	if client.lastDeleteAutomationReq == nil || client.lastDeleteAutomationReq.Id != "auto-1" || client.lastDeleteAutomationReq.TenantId != "tenant-1" {
		t.Fatalf("unexpected DeleteAutomation request: %+v", client.lastDeleteAutomationReq)
	}
}

func TestHandleDeleteAutomation_GRPCErrorMapsToHTTPStatus(t *testing.T) {
	client := &fakeAutomationServiceClient{
		deleteAutomationErr: status.Error(codes.NotFound, "automation not found"),
	}
	router := testAutomationRouter(client)

	req := requestWithIdentity(http.MethodDelete, "/v1/automations/auto-404", nil, usecase.Identity{TenantID: "tenant-1", UserID: "user-1"})
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusNotFound, rec.Body.String())
	}
}

func strPtr(s string) *string { return &s }
