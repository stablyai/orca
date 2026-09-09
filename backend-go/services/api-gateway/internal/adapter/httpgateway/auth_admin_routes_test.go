package httpgateway

import (
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

	authv1 "github.com/stablyai/orca-go/proto/gen/go/orca/auth/v1"
)

// fakeAdminAuthServiceClient implements authv1.AuthServiceClient with a
// single configurable canned response/error used by whichever RPC the test
// exercises — the login-flow methods (Login, Logout, ValidateSession,
// IssueServiceToken, GetJWKS) are thin unused pass-throughs, present only
// because Go requires every interface method to compile.
type fakeAdminAuthServiceClient struct {
	listUsersResp *authv1.ListUsersResponse
	err           error

	statsResp             *authv1.GetAdminStatsResponse
	queryAuditLogResp     *authv1.QueryAuditLogResponse
	deactivateUserResp    *authv1.DeactivateUserResponse
	listSessionsResp      *authv1.ListSessionsForUserResponse
	forceRevokeAllResp    *authv1.ForceRevokeAllSessionsForUserResponse
	listPoliciesResp      *authv1.ListAccessPoliciesResponse
	createPolicyResp      *authv1.AccessPolicy
	updatePolicyResp      *authv1.AccessPolicy
	lastCreatePolicyReq   *authv1.CreateAccessPolicyRequest
	lastUpdatePolicyReq   *authv1.UpdateAccessPolicyRequest
	lastDeactivateUserReq *authv1.DeactivateUserRequest
	lastListSessionsReq   *authv1.ListSessionsForUserRequest
	lastForceRevokeAllReq *authv1.ForceRevokeAllSessionsForUserRequest
	lastDeletePolicyReq   *authv1.DeleteAccessPolicyRequest
}

func (f *fakeAdminAuthServiceClient) Login(ctx context.Context, in *authv1.LoginRequest, opts ...grpc.CallOption) (*authv1.LoginResponse, error) {
	return nil, status.Error(codes.Unimplemented, "not used by this test")
}

func (f *fakeAdminAuthServiceClient) Logout(ctx context.Context, in *authv1.LogoutRequest, opts ...grpc.CallOption) (*authv1.LogoutResponse, error) {
	return nil, status.Error(codes.Unimplemented, "not used by this test")
}

func (f *fakeAdminAuthServiceClient) ValidateSession(ctx context.Context, in *authv1.ValidateSessionRequest, opts ...grpc.CallOption) (*authv1.ValidateSessionResponse, error) {
	return nil, status.Error(codes.Unimplemented, "not used by this test")
}

func (f *fakeAdminAuthServiceClient) IssueServiceToken(ctx context.Context, in *authv1.IssueServiceTokenRequest, opts ...grpc.CallOption) (*authv1.IssueServiceTokenResponse, error) {
	return nil, status.Error(codes.Unimplemented, "not used by this test")
}

func (f *fakeAdminAuthServiceClient) GetJWKS(ctx context.Context, in *authv1.GetJWKSRequest, opts ...grpc.CallOption) (*authv1.GetJWKSResponse, error) {
	return nil, status.Error(codes.Unimplemented, "not used by this test")
}

func (f *fakeAdminAuthServiceClient) CreateUser(ctx context.Context, in *authv1.CreateUserRequest, opts ...grpc.CallOption) (*authv1.CreateUserResponse, error) {
	return nil, status.Error(codes.Unimplemented, "not used by this test")
}

func (f *fakeAdminAuthServiceClient) ListUsers(ctx context.Context, in *authv1.ListUsersRequest, opts ...grpc.CallOption) (*authv1.ListUsersResponse, error) {
	if f.err != nil {
		return nil, f.err
	}
	return f.listUsersResp, nil
}

func (f *fakeAdminAuthServiceClient) UpdateUserRole(ctx context.Context, in *authv1.UpdateUserRoleRequest, opts ...grpc.CallOption) (*authv1.UpdateUserRoleResponse, error) {
	return nil, status.Error(codes.Unimplemented, "not used by this test")
}

func (f *fakeAdminAuthServiceClient) ListTenantMemberDirectory(ctx context.Context, in *authv1.ListTenantMemberDirectoryRequest, opts ...grpc.CallOption) (*authv1.ListTenantMemberDirectoryResponse, error) {
	return nil, status.Error(codes.Unimplemented, "not used by this test")
}

func (f *fakeAdminAuthServiceClient) RevokeSession(ctx context.Context, in *authv1.RevokeSessionRequest, opts ...grpc.CallOption) (*authv1.RevokeSessionResponse, error) {
	if f.err != nil {
		return nil, f.err
	}
	return &authv1.RevokeSessionResponse{}, nil
}

func (f *fakeAdminAuthServiceClient) QueryAuditLog(ctx context.Context, in *authv1.QueryAuditLogRequest, opts ...grpc.CallOption) (*authv1.QueryAuditLogResponse, error) {
	if f.err != nil {
		return nil, f.err
	}
	if f.queryAuditLogResp != nil {
		return f.queryAuditLogResp, nil
	}
	return &authv1.QueryAuditLogResponse{}, nil
}

func (f *fakeAdminAuthServiceClient) DeactivateUser(ctx context.Context, in *authv1.DeactivateUserRequest, opts ...grpc.CallOption) (*authv1.DeactivateUserResponse, error) {
	f.lastDeactivateUserReq = in
	if f.err != nil {
		return nil, f.err
	}
	return f.deactivateUserResp, nil
}

func (f *fakeAdminAuthServiceClient) ReactivateUser(ctx context.Context, in *authv1.ReactivateUserRequest, opts ...grpc.CallOption) (*authv1.ReactivateUserResponse, error) {
	return nil, status.Error(codes.Unimplemented, "not used by this test")
}

func (f *fakeAdminAuthServiceClient) ListSessionsForUser(ctx context.Context, in *authv1.ListSessionsForUserRequest, opts ...grpc.CallOption) (*authv1.ListSessionsForUserResponse, error) {
	f.lastListSessionsReq = in
	if f.err != nil {
		return nil, f.err
	}
	return f.listSessionsResp, nil
}

func (f *fakeAdminAuthServiceClient) ForceRevokeAllSessionsForUser(ctx context.Context, in *authv1.ForceRevokeAllSessionsForUserRequest, opts ...grpc.CallOption) (*authv1.ForceRevokeAllSessionsForUserResponse, error) {
	f.lastForceRevokeAllReq = in
	if f.err != nil {
		return nil, f.err
	}
	return f.forceRevokeAllResp, nil
}

// ForceRevokeSession (TASK-BE-002): unused by this file's tests — stub
// added only so this fake keeps satisfying AuthServiceClient after the
// interface grew this method.
func (f *fakeAdminAuthServiceClient) ForceRevokeSession(ctx context.Context, in *authv1.ForceRevokeSessionRequest, opts ...grpc.CallOption) (*emptypb.Empty, error) {
	return nil, status.Error(codes.Unimplemented, "not used by this test")
}

func (f *fakeAdminAuthServiceClient) CreateAccessPolicy(ctx context.Context, in *authv1.CreateAccessPolicyRequest, opts ...grpc.CallOption) (*authv1.AccessPolicy, error) {
	f.lastCreatePolicyReq = in
	if f.err != nil {
		return nil, f.err
	}
	return f.createPolicyResp, nil
}

func (f *fakeAdminAuthServiceClient) GetAccessPolicy(ctx context.Context, in *authv1.GetAccessPolicyRequest, opts ...grpc.CallOption) (*authv1.AccessPolicy, error) {
	return nil, status.Error(codes.Unimplemented, "not used by this test")
}

func (f *fakeAdminAuthServiceClient) ListAccessPolicies(ctx context.Context, in *authv1.ListAccessPoliciesRequest, opts ...grpc.CallOption) (*authv1.ListAccessPoliciesResponse, error) {
	if f.err != nil {
		return nil, f.err
	}
	return f.listPoliciesResp, nil
}

func (f *fakeAdminAuthServiceClient) UpdateAccessPolicy(ctx context.Context, in *authv1.UpdateAccessPolicyRequest, opts ...grpc.CallOption) (*authv1.AccessPolicy, error) {
	f.lastUpdatePolicyReq = in
	if f.err != nil {
		return nil, f.err
	}
	return f.updatePolicyResp, nil
}

func (f *fakeAdminAuthServiceClient) DeleteAccessPolicy(ctx context.Context, in *authv1.DeleteAccessPolicyRequest, opts ...grpc.CallOption) (*emptypb.Empty, error) {
	f.lastDeletePolicyReq = in
	if f.err != nil {
		return nil, f.err
	}
	return &emptypb.Empty{}, nil
}

func (f *fakeAdminAuthServiceClient) GetAdminStats(ctx context.Context, in *authv1.GetAdminStatsRequest, opts ...grpc.CallOption) (*authv1.GetAdminStatsResponse, error) {
	if f.err != nil {
		return nil, f.err
	}
	return f.statsResp, nil
}

func (f *fakeAdminAuthServiceClient) StartSsoLogin(ctx context.Context, in *authv1.StartSsoLoginRequest, opts ...grpc.CallOption) (*authv1.StartSsoLoginResponse, error) {
	return nil, status.Error(codes.Unimplemented, "not used by this test")
}

func (f *fakeAdminAuthServiceClient) CompleteSsoLogin(ctx context.Context, in *authv1.CompleteSsoLoginRequest, opts ...grpc.CallOption) (*authv1.CompleteSsoLoginResponse, error) {
	return nil, status.Error(codes.Unimplemented, "not used by this test")
}

// AppendAuditEntry/RefreshSession/UpdateSsoGroupMapping/ListSsoGroupMapping:
// unused pass-throughs, present only so this fake keeps satisfying
// authv1.AuthServiceClient as the interface grows (TASK-BE-017,
// CR-RBAC-003) — none of this file's tests exercise them.
func (f *fakeAdminAuthServiceClient) AppendAuditEntry(ctx context.Context, in *authv1.AppendAuditEntryRequest, opts ...grpc.CallOption) (*emptypb.Empty, error) {
	return nil, status.Error(codes.Unimplemented, "not used by this test")
}

func (f *fakeAdminAuthServiceClient) IsServiceTokenRevoked(ctx context.Context, in *authv1.IsServiceTokenRevokedRequest, opts ...grpc.CallOption) (*authv1.IsServiceTokenRevokedResponse, error) {
	return nil, status.Error(codes.Unimplemented, "not used by this test")
}

func (f *fakeAdminAuthServiceClient) ListCliTokens(ctx context.Context, in *authv1.ListCliTokensRequest, opts ...grpc.CallOption) (*authv1.ListCliTokensResponse, error) {
	return nil, status.Error(codes.Unimplemented, "not used by this test")
}

func (f *fakeAdminAuthServiceClient) RevokeCliToken(ctx context.Context, in *authv1.RevokeCliTokenRequest, opts ...grpc.CallOption) (*emptypb.Empty, error) {
	return nil, status.Error(codes.Unimplemented, "not used by this test")
}

func (f *fakeAdminAuthServiceClient) RefreshSession(ctx context.Context, in *authv1.RefreshSessionRequest, opts ...grpc.CallOption) (*authv1.RefreshSessionResponse, error) {
	return nil, status.Error(codes.Unimplemented, "not used by this test")
}

func (f *fakeAdminAuthServiceClient) UpdateSsoGroupMapping(ctx context.Context, in *authv1.UpdateSsoGroupMappingRequest, opts ...grpc.CallOption) (*authv1.UpdateSsoGroupMappingResponse, error) {
	return nil, status.Error(codes.Unimplemented, "not used by this test")
}

func (f *fakeAdminAuthServiceClient) ListSsoGroupMapping(ctx context.Context, in *authv1.ListSsoGroupMappingRequest, opts ...grpc.CallOption) (*authv1.ListSsoGroupMappingResponse, error) {
	return nil, status.Error(codes.Unimplemented, "not used by this test")
}

var _ authv1.AuthServiceClient = (*fakeAdminAuthServiceClient)(nil)

// testAuthAdminRouter mounts mountAuthAdminRoutes standalone and injects a
// test Identity into request context the way authMiddleware would (see
// middleware.go's withIdentity) — this test targets mountAuthAdminRoutes in
// isolation, not the full NewRouter wiring.
func testAuthAdminRouter(client authv1.AuthServiceClient) http.Handler {
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := withIdentity(r.Context(), usecase.Identity{TenantID: "tenant-1", UserID: "user-1"})
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	})
	mountAuthAdminRoutes(r, client)
	return r
}

func TestHandleListUsers_SuccessRoundTrip(t *testing.T) {
	client := &fakeAdminAuthServiceClient{
		listUsersResp: &authv1.ListUsersResponse{
			Users: []*authv1.User{
				{Id: "user-1", TenantId: "tenant-1", Email: "a@example.com", Role: authv1.Role_ROLE_ADMIN},
			},
			NextPageToken: "next-token",
		},
	}
	router := testAuthAdminRouter(client)

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/auth/users", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}

	// usersListJSON's shape (camelCase nextPageToken, plus the total field
	// the old raw-proto passthrough dropped) — see auth_admin_routes.go's
	// doc comment (specs/backend-go/bugs/missing-v2/ follow-up).
	var body struct {
		Users []struct {
			ID    string `json:"id"`
			Email string `json:"email"`
			Role  string `json:"role"`
		} `json:"users"`
		Total         int    `json:"total"`
		NextPageToken string `json:"nextPageToken"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("response body is not the expected JSON shape: %v; body=%s", err, rec.Body.String())
	}
	if len(body.Users) != 1 || body.Users[0].ID != "user-1" || body.Users[0].Email != "a@example.com" {
		t.Fatalf("unexpected users in response: %+v", body.Users)
	}
	if body.Users[0].Role != "admin" {
		t.Fatalf("role = %q, want %q (string, not the numeric proto enum)", body.Users[0].Role, "admin")
	}
	if body.Total != 1 {
		t.Fatalf("total = %d, want %d", body.Total, 1)
	}
	if body.NextPageToken != "next-token" {
		t.Fatalf("nextPageToken = %q, want %q", body.NextPageToken, "next-token")
	}
}

func TestHandleListUsers_PermissionDeniedMapsTo403(t *testing.T) {
	client := &fakeAdminAuthServiceClient{
		err: status.Error(codes.PermissionDenied, "caller is not an admin"),
	}
	router := testAuthAdminRouter(client)

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/auth/users", nil))

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusForbidden, rec.Body.String())
	}

	var body errorBody
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("response body is not the expected JSON shape: %v; body=%s", err, rec.Body.String())
	}
	if body.Error.Code != codes.PermissionDenied.String() {
		t.Fatalf("error.code = %q, want %q", body.Error.Code, codes.PermissionDenied.String())
	}
}
