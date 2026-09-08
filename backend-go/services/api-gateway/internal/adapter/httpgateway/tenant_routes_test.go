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

	tenantv1 "github.com/stablyai/orca-go/proto/gen/go/orca/tenant/v1"
)

// fakeTenantServiceClient implements tenantv1.TenantServiceClient with
// per-method canned responses/errors, configurable per test — mirroring
// fakeTaskServiceClient's shape in task_routes_test.go.
type fakeTenantServiceClient struct {
	createCompanyResp *tenantv1.CreateCompanyResponse
	createCompanyErr  error

	validateTenantResp *tenantv1.ValidateTenantResponse
	validateTenantErr  error

	createDepartmentResp *tenantv1.CreateDepartmentResponse
	createDepartmentErr  error

	setUserDepartmentResp *tenantv1.SetUserDepartmentResponse
	setUserDepartmentErr  error

	getResolvedProfileResp *tenantv1.GetResolvedProfileResponse
	getResolvedProfileErr  error

	createTeamResp *tenantv1.CreateTeamResponse
	createTeamErr  error
	createTeamReq  *tenantv1.CreateTeamRequest // captures the last request for assertions

	addTeamMemberResp *tenantv1.AddTeamMemberResponse
	addTeamMemberErr  error

	listTeamMembersResp *tenantv1.ListTeamMembersResponse
	listTeamMembersErr  error

	getUserProfileResp *tenantv1.GetUserProfileResponse
	getUserProfileErr  error

	listDepartmentsResp *tenantv1.ListDepartmentsResponse
	listDepartmentsErr  error

	updateCompanyResp *tenantv1.UpdateCompanyResponse
	updateCompanyErr  error

	updateDepartmentResp *tenantv1.UpdateDepartmentResponse
	updateDepartmentErr  error

	updateUserProfileResp *tenantv1.UpdateUserProfileResponse
	updateUserProfileErr  error
}

func (f *fakeTenantServiceClient) CreateCompany(_ context.Context, _ *tenantv1.CreateCompanyRequest, _ ...grpc.CallOption) (*tenantv1.CreateCompanyResponse, error) {
	if f.createCompanyErr != nil {
		return nil, f.createCompanyErr
	}
	return f.createCompanyResp, nil
}

// GetCompany is unused by this file's tests today — a minimal stub keeps
// fakeTenantServiceClient satisfying tenantv1.TenantServiceClient (this
// fake predates the embed-the-nil-interface pattern used elsewhere in this
// package, so every new interface method needs an explicit stub here).
func (f *fakeTenantServiceClient) GetCompany(_ context.Context, _ *tenantv1.GetCompanyRequest, _ ...grpc.CallOption) (*tenantv1.GetCompanyResponse, error) {
	return &tenantv1.GetCompanyResponse{}, nil
}

// GetOnboardingState/SetOnboardingState are unused by this file's tests
// today — same stub rationale as GetCompany above.
func (f *fakeTenantServiceClient) GetOnboardingState(_ context.Context, _ *tenantv1.GetOnboardingStateRequest, _ ...grpc.CallOption) (*tenantv1.GetOnboardingStateResponse, error) {
	return &tenantv1.GetOnboardingStateResponse{}, nil
}

func (f *fakeTenantServiceClient) SetOnboardingState(_ context.Context, _ *tenantv1.SetOnboardingStateRequest, _ ...grpc.CallOption) (*emptypb.Empty, error) {
	return &emptypb.Empty{}, nil
}

// ListCompanies is unused by this file's tests today — same stub rationale
// as GetCompany above.
func (f *fakeTenantServiceClient) ListCompanies(_ context.Context, _ *tenantv1.ListCompaniesRequest, _ ...grpc.CallOption) (*tenantv1.ListCompaniesResponse, error) {
	return &tenantv1.ListCompaniesResponse{}, nil
}

func (f *fakeTenantServiceClient) ValidateTenant(_ context.Context, _ *tenantv1.ValidateTenantRequest, _ ...grpc.CallOption) (*tenantv1.ValidateTenantResponse, error) {
	if f.validateTenantErr != nil {
		return nil, f.validateTenantErr
	}
	return f.validateTenantResp, nil
}

func (f *fakeTenantServiceClient) CreateDepartment(_ context.Context, _ *tenantv1.CreateDepartmentRequest, _ ...grpc.CallOption) (*tenantv1.CreateDepartmentResponse, error) {
	if f.createDepartmentErr != nil {
		return nil, f.createDepartmentErr
	}
	return f.createDepartmentResp, nil
}

func (f *fakeTenantServiceClient) SetUserDepartment(_ context.Context, _ *tenantv1.SetUserDepartmentRequest, _ ...grpc.CallOption) (*tenantv1.SetUserDepartmentResponse, error) {
	if f.setUserDepartmentErr != nil {
		return nil, f.setUserDepartmentErr
	}
	return f.setUserDepartmentResp, nil
}

func (f *fakeTenantServiceClient) GetResolvedProfile(_ context.Context, _ *tenantv1.GetResolvedProfileRequest, _ ...grpc.CallOption) (*tenantv1.GetResolvedProfileResponse, error) {
	if f.getResolvedProfileErr != nil {
		return nil, f.getResolvedProfileErr
	}
	return f.getResolvedProfileResp, nil
}

func (f *fakeTenantServiceClient) CreateTeam(_ context.Context, in *tenantv1.CreateTeamRequest, _ ...grpc.CallOption) (*tenantv1.CreateTeamResponse, error) {
	f.createTeamReq = in
	if f.createTeamErr != nil {
		return nil, f.createTeamErr
	}
	return f.createTeamResp, nil
}

func (f *fakeTenantServiceClient) AddTeamMember(_ context.Context, _ *tenantv1.AddTeamMemberRequest, _ ...grpc.CallOption) (*tenantv1.AddTeamMemberResponse, error) {
	if f.addTeamMemberErr != nil {
		return nil, f.addTeamMemberErr
	}
	return f.addTeamMemberResp, nil
}

func (f *fakeTenantServiceClient) ListTeamMembers(_ context.Context, _ *tenantv1.ListTeamMembersRequest, _ ...grpc.CallOption) (*tenantv1.ListTeamMembersResponse, error) {
	if f.listTeamMembersErr != nil {
		return nil, f.listTeamMembersErr
	}
	return f.listTeamMembersResp, nil
}

func (f *fakeTenantServiceClient) GetUserProfile(_ context.Context, _ *tenantv1.GetUserProfileRequest, _ ...grpc.CallOption) (*tenantv1.GetUserProfileResponse, error) {
	if f.getUserProfileErr != nil {
		return nil, f.getUserProfileErr
	}
	return f.getUserProfileResp, nil
}

func (f *fakeTenantServiceClient) ListDepartments(_ context.Context, _ *tenantv1.ListDepartmentsRequest, _ ...grpc.CallOption) (*tenantv1.ListDepartmentsResponse, error) {
	if f.listDepartmentsErr != nil {
		return nil, f.listDepartmentsErr
	}
	return f.listDepartmentsResp, nil
}

func (f *fakeTenantServiceClient) UpdateCompany(_ context.Context, _ *tenantv1.UpdateCompanyRequest, _ ...grpc.CallOption) (*tenantv1.UpdateCompanyResponse, error) {
	if f.updateCompanyErr != nil {
		return nil, f.updateCompanyErr
	}
	return f.updateCompanyResp, nil
}

func (f *fakeTenantServiceClient) UpdateDepartment(_ context.Context, _ *tenantv1.UpdateDepartmentRequest, _ ...grpc.CallOption) (*tenantv1.UpdateDepartmentResponse, error) {
	if f.updateDepartmentErr != nil {
		return nil, f.updateDepartmentErr
	}
	return f.updateDepartmentResp, nil
}

func (f *fakeTenantServiceClient) UpdateUserProfile(_ context.Context, _ *tenantv1.UpdateUserProfileRequest, _ ...grpc.CallOption) (*tenantv1.UpdateUserProfileResponse, error) {
	if f.updateUserProfileErr != nil {
		return nil, f.updateUserProfileErr
	}
	return f.updateUserProfileResp, nil
}

// ListTeams and RemoveTeamMember: no route in this file's tests exercises
// them, so these exist only to satisfy the tenantv1.TenantServiceClient
// interface this fake must implement in full.
func (f *fakeTenantServiceClient) ListTeams(_ context.Context, _ *tenantv1.ListTeamsRequest, _ ...grpc.CallOption) (*tenantv1.ListTeamsResponse, error) {
	return nil, status.Error(codes.Unimplemented, "not used by tenant_routes_test.go")
}

func (f *fakeTenantServiceClient) RemoveTeamMember(_ context.Context, _ *tenantv1.RemoveTeamMemberRequest, _ ...grpc.CallOption) (*emptypb.Empty, error) {
	return nil, status.Error(codes.Unimplemented, "not used by tenant_routes_test.go")
}

// ListTeamsForUser (BUG-013, TASK-039/040/041) — not exercised by any route
// in this file's tests either, same as ListTeams/RemoveTeamMember above.
func (f *fakeTenantServiceClient) ListTeamsForUser(_ context.Context, _ *tenantv1.ListTeamsForUserRequest, _ ...grpc.CallOption) (*tenantv1.ListTeamsForUserResponse, error) {
	return nil, status.Error(codes.Unimplemented, "not used by tenant_routes_test.go")
}

func (f *fakeTenantServiceClient) AddCompanyEmailDomain(_ context.Context, _ *tenantv1.AddCompanyEmailDomainRequest, _ ...grpc.CallOption) (*tenantv1.AddCompanyEmailDomainResponse, error) {
	return nil, status.Error(codes.Unimplemented, "not used by tenant_routes_test.go")
}

func (f *fakeTenantServiceClient) RemoveCompanyEmailDomain(_ context.Context, _ *tenantv1.RemoveCompanyEmailDomainRequest, _ ...grpc.CallOption) (*emptypb.Empty, error) {
	return nil, status.Error(codes.Unimplemented, "not used by tenant_routes_test.go")
}

func (f *fakeTenantServiceClient) ListCompanyEmailDomains(_ context.Context, _ *tenantv1.ListCompanyEmailDomainsRequest, _ ...grpc.CallOption) (*tenantv1.ListCompanyEmailDomainsResponse, error) {
	return nil, status.Error(codes.Unimplemented, "not used by tenant_routes_test.go")
}

func (f *fakeTenantServiceClient) ResolveCompanyByEmailDomain(_ context.Context, _ *tenantv1.ResolveCompanyByEmailDomainRequest, _ ...grpc.CallOption) (*tenantv1.ResolveCompanyByEmailDomainResponse, error) {
	return nil, status.Error(codes.Unimplemented, "not used by tenant_routes_test.go")
}

// The starNag.* RPCs below (TASK-011/012) are not exercised by
// tenant_routes_test.go (an HTTP-routes test, not a wscompat one) — added
// only because this fake implements tenantv1.TenantServiceClient
// explicitly (no embedded interface), so every new interface method needs
// a stub here to keep compiling.
func (f *fakeTenantServiceClient) DismissStarNag(_ context.Context, _ *tenantv1.DismissStarNagRequest, _ ...grpc.CallOption) (*emptypb.Empty, error) {
	return nil, status.Error(codes.Unimplemented, "not used by tenant_routes_test.go")
}

func (f *fakeTenantServiceClient) DeferStarNag(_ context.Context, _ *tenantv1.DeferStarNagRequest, _ ...grpc.CallOption) (*emptypb.Empty, error) {
	return nil, status.Error(codes.Unimplemented, "not used by tenant_routes_test.go")
}

func (f *fakeTenantServiceClient) CompleteStarNag(_ context.Context, _ *tenantv1.CompleteStarNagRequest, _ ...grpc.CallOption) (*emptypb.Empty, error) {
	return nil, status.Error(codes.Unimplemented, "not used by tenant_routes_test.go")
}

func (f *fakeTenantServiceClient) DisableStarNag(_ context.Context, _ *tenantv1.DisableStarNagRequest, _ ...grpc.CallOption) (*emptypb.Empty, error) {
	return nil, status.Error(codes.Unimplemented, "not used by tenant_routes_test.go")
}

func (f *fakeTenantServiceClient) ForceShowStarNag(_ context.Context, _ *tenantv1.ForceShowStarNagRequest, _ ...grpc.CallOption) (*emptypb.Empty, error) {
	return nil, status.Error(codes.Unimplemented, "not used by tenant_routes_test.go")
}

func (f *fakeTenantServiceClient) NotifyStarNagOnboardingCompleted(_ context.Context, _ *tenantv1.NotifyStarNagOnboardingCompletedRequest, _ ...grpc.CallOption) (*emptypb.Empty, error) {
	return nil, status.Error(codes.Unimplemented, "not used by tenant_routes_test.go")
}

func (f *fakeTenantServiceClient) OpenWebStarNag(_ context.Context, _ *tenantv1.OpenWebStarNagRequest, _ ...grpc.CallOption) (*emptypb.Empty, error) {
	return nil, status.Error(codes.Unimplemented, "not used by tenant_routes_test.go")
}

func (f *fakeTenantServiceClient) StarOrcaFromNag(_ context.Context, _ *tenantv1.StarOrcaFromNagRequest, _ ...grpc.CallOption) (*tenantv1.StarOrcaFromNagResponse, error) {
	return nil, status.Error(codes.Unimplemented, "not used by tenant_routes_test.go")
}

func (f *fakeTenantServiceClient) PrepareStarNagAgentValueMoment(_ context.Context, _ *tenantv1.PrepareStarNagAgentValueMomentRequest, _ ...grpc.CallOption) (*tenantv1.StarNagAgentValueMomentPreparation, error) {
	return nil, status.Error(codes.Unimplemented, "not used by tenant_routes_test.go")
}

func (f *fakeTenantServiceClient) ShowPreparedStarNagAgentValueMoment(_ context.Context, _ *tenantv1.ShowPreparedStarNagAgentValueMomentRequest, _ ...grpc.CallOption) (*emptypb.Empty, error) {
	return nil, status.Error(codes.Unimplemented, "not used by tenant_routes_test.go")
}

// The clientState.*/workspaceSession.* RPCs below (CR-STORAGE-001/003/004)
// are not exercised by tenant_routes_test.go either — same reason as the
// starNag.* stubs above, this fake has no embedded interface so every new
// TenantServiceClient method needs a stub here to keep compiling.
func (f *fakeTenantServiceClient) GetClientState(_ context.Context, _ *tenantv1.GetClientStateRequest, _ ...grpc.CallOption) (*tenantv1.GetClientStateResponse, error) {
	return nil, status.Error(codes.Unimplemented, "not used by tenant_routes_test.go")
}

func (f *fakeTenantServiceClient) SetClientState(_ context.Context, _ *tenantv1.SetClientStateRequest, _ ...grpc.CallOption) (*emptypb.Empty, error) {
	return nil, status.Error(codes.Unimplemented, "not used by tenant_routes_test.go")
}

func (f *fakeTenantServiceClient) GetWorkspaceSession(_ context.Context, _ *tenantv1.GetWorkspaceSessionRequest, _ ...grpc.CallOption) (*tenantv1.GetWorkspaceSessionResponse, error) {
	return nil, status.Error(codes.Unimplemented, "not used by tenant_routes_test.go")
}

func (f *fakeTenantServiceClient) SetWorkspaceSession(_ context.Context, _ *tenantv1.SetWorkspaceSessionRequest, _ ...grpc.CallOption) (*emptypb.Empty, error) {
	return nil, status.Error(codes.Unimplemented, "not used by tenant_routes_test.go")
}

func (f *fakeTenantServiceClient) PatchWorkspaceSession(_ context.Context, _ *tenantv1.PatchWorkspaceSessionRequest, _ ...grpc.CallOption) (*emptypb.Empty, error) {
	return nil, status.Error(codes.Unimplemented, "not used by tenant_routes_test.go")
}

// tenantTestRouter mounts mountTenantRoutes standalone (router.go isn't
// touched by this package's tests, per task instructions) and injects an
// identity into the request context the same way authMiddleware would.
func tenantTestRouter(client tenantv1.TenantServiceClient) chi.Router {
	r := chi.NewRouter()
	mountTenantRoutes(r, client)
	return r
}

func TestHandleCreateTeam_SuccessRoundTrip(t *testing.T) {
	fake := &fakeTenantServiceClient{
		createTeamResp: &tenantv1.CreateTeamResponse{
			Team: &tenantv1.Team{
				Id:           "team-1",
				CompanyId:    "company-1",
				Name:         "Platform",
				SettingsJson: `{"theme":"dark"}`,
			},
		},
	}
	router := tenantTestRouter(fake)

	body, _ := json.Marshal(createTeamRequestBody{
		CompanyID:    "company-1",
		Name:         "Platform",
		SettingsJSON: `{"theme":"dark"}`,
	})
	req := httptest.NewRequest(http.MethodPost, "/v1/tenants/teams", bytes.NewReader(body))
	req = withTestIdentity(req, usecase.Identity{TenantID: "tenant-1", UserID: "user-1"})

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusCreated, rec.Body.String())
	}

	var gotTeam tenantv1.Team
	if err := json.Unmarshal(rec.Body.Bytes(), &gotTeam); err != nil {
		t.Fatalf("response body is not the expected Team JSON shape: %v; body=%s", err, rec.Body.String())
	}
	if gotTeam.GetId() != "team-1" || gotTeam.GetName() != "Platform" {
		t.Fatalf("unexpected team in response: %+v", &gotTeam)
	}

	// settings_json must round-trip from the REST body into the gRPC
	// request sent upstream.
	if fake.createTeamReq == nil {
		t.Fatal("CreateTeam was never called")
	}
	if fake.createTeamReq.GetSettingsJson() != `{"theme":"dark"}` {
		t.Fatalf("SettingsJson sent upstream = %q, want %q", fake.createTeamReq.GetSettingsJson(), `{"theme":"dark"}`)
	}
	if fake.createTeamReq.GetCompanyId() != "company-1" {
		t.Fatalf("CompanyId sent upstream = %q, want %q", fake.createTeamReq.GetCompanyId(), "company-1")
	}
}

func TestHandleGetResolvedProfile_GRPCErrorMapsToHTTPStatus(t *testing.T) {
	fake := &fakeTenantServiceClient{
		getResolvedProfileErr: status.Error(codes.NotFound, "profile not found"),
	}
	router := tenantTestRouter(fake)

	req := httptest.NewRequest(http.MethodGet, "/v1/tenants/profile", nil)
	req = withTestIdentity(req, usecase.Identity{TenantID: "tenant-1", UserID: "user-1"})

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusNotFound, rec.Body.String())
	}

	var body errorBody
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("response body is not the expected error JSON shape: %v; body=%s", err, rec.Body.String())
	}
	if body.Error.Code != codes.NotFound.String() {
		t.Fatalf("error.code = %q, want %q", body.Error.Code, codes.NotFound.String())
	}
}
