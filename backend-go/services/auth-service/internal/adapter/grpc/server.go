// Package grpc implements the generated authv1.AuthServiceServer interface
// by translating wire messages to/from usecase calls — no business logic
// here, per specs/backend-go/architecture/03-clean-architecture-guidelines.md's
// inbound-adapter contract.
package grpc

import (
	"context"
	"time"

	"google.golang.org/protobuf/types/known/emptypb"
	"google.golang.org/protobuf/types/known/timestamppb"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/common/tenant"
	"github.com/stablyai/orca-go/services/auth-service/internal/domain"
	"github.com/stablyai/orca-go/services/auth-service/internal/usecase"

	authv1 "github.com/stablyai/orca-go/proto/gen/go/orca/auth/v1"
)

// Server implements authv1.UnimplementedAuthServiceServer.
type Server struct {
	authv1.UnimplementedAuthServiceServer

	login             *usecase.Login
	logout            *usecase.Logout
	validateSession   *usecase.ValidateSession
	createUser        *usecase.CreateUser
	listUsers         *usecase.ListUsers
	updateUserRole    *usecase.UpdateUserRole
	revokeSession     *usecase.RevokeSession
	queryAuditLog     *usecase.QueryAuditLog
	appendAuditEntry  *usecase.AppendAuditEntry
	issueServiceToken *usecase.IssueServiceToken
	getJWKS           *usecase.GetJWKS

	// CR-CLI-002 (headless CLI credential) — TASK-BE-CLI-005/006.
	isServiceTokenRevoked *usecase.IsServiceTokenRevoked
	listCliTokens         *usecase.ListCliTokens
	revokeCliToken        *usecase.RevokeCliToken

	deactivateUser                *usecase.DeactivateUser
	reactivateUser                *usecase.ReactivateUser
	listSessionsForUser           *usecase.ListSessionsForUser
	forceRevokeAllSessionsForUser *usecase.ForceRevokeAllSessionsForUser
	forceRevokeSession            *usecase.ForceRevokeSession
	createAccessPolicy            *usecase.CreateAccessPolicy
	getAccessPolicy               *usecase.GetAccessPolicy
	listAccessPolicies            *usecase.ListAccessPolicies
	updateAccessPolicy            *usecase.UpdateAccessPolicy
	deleteAccessPolicy            *usecase.DeleteAccessPolicy
	getAdminStats                 *usecase.GetAdminStats

	listTenantMemberDirectory *usecase.ListTenantMemberDirectory

	startSsoLogin    *usecase.StartSsoLogin
	completeSsoLogin *usecase.CompleteSsoLogin

	// CR-RBAC-003 (SSO group->role mapping, session refresh).
	refreshSession        *usecase.RefreshSession
	updateSsoGroupMapping *usecase.UpdateSsoGroupMapping
	listSsoGroupMapping   *usecase.ListSsoGroupMapping
}

func New(
	login *usecase.Login,
	logout *usecase.Logout,
	validateSession *usecase.ValidateSession,
	createUser *usecase.CreateUser,
	listUsers *usecase.ListUsers,
	updateUserRole *usecase.UpdateUserRole,
	revokeSession *usecase.RevokeSession,
	queryAuditLog *usecase.QueryAuditLog,
	appendAuditEntry *usecase.AppendAuditEntry,
	issueServiceToken *usecase.IssueServiceToken,
	getJWKS *usecase.GetJWKS,
	isServiceTokenRevoked *usecase.IsServiceTokenRevoked,
	listCliTokens *usecase.ListCliTokens,
	revokeCliToken *usecase.RevokeCliToken,
	deactivateUser *usecase.DeactivateUser,
	reactivateUser *usecase.ReactivateUser,
	listSessionsForUser *usecase.ListSessionsForUser,
	forceRevokeAllSessionsForUser *usecase.ForceRevokeAllSessionsForUser,
	forceRevokeSession *usecase.ForceRevokeSession,
	createAccessPolicy *usecase.CreateAccessPolicy,
	getAccessPolicy *usecase.GetAccessPolicy,
	listAccessPolicies *usecase.ListAccessPolicies,
	updateAccessPolicy *usecase.UpdateAccessPolicy,
	deleteAccessPolicy *usecase.DeleteAccessPolicy,
	getAdminStats *usecase.GetAdminStats,
	listTenantMemberDirectory *usecase.ListTenantMemberDirectory,
	startSsoLogin *usecase.StartSsoLogin,
	completeSsoLogin *usecase.CompleteSsoLogin,
	refreshSession *usecase.RefreshSession,
	updateSsoGroupMapping *usecase.UpdateSsoGroupMapping,
	listSsoGroupMapping *usecase.ListSsoGroupMapping,
) *Server {
	return &Server{
		login:             login,
		logout:            logout,
		validateSession:   validateSession,
		createUser:        createUser,
		listUsers:         listUsers,
		updateUserRole:    updateUserRole,
		revokeSession:     revokeSession,
		queryAuditLog:     queryAuditLog,
		appendAuditEntry:  appendAuditEntry,
		issueServiceToken: issueServiceToken,
		getJWKS:           getJWKS,

		isServiceTokenRevoked: isServiceTokenRevoked,
		listCliTokens:         listCliTokens,
		revokeCliToken:        revokeCliToken,

		deactivateUser:                deactivateUser,
		reactivateUser:                reactivateUser,
		listSessionsForUser:           listSessionsForUser,
		forceRevokeAllSessionsForUser: forceRevokeAllSessionsForUser,
		forceRevokeSession:            forceRevokeSession,
		createAccessPolicy:            createAccessPolicy,
		getAccessPolicy:               getAccessPolicy,
		listAccessPolicies:            listAccessPolicies,
		updateAccessPolicy:            updateAccessPolicy,
		deleteAccessPolicy:            deleteAccessPolicy,
		getAdminStats:                 getAdminStats,

		listTenantMemberDirectory: listTenantMemberDirectory,

		startSsoLogin:    startSsoLogin,
		completeSsoLogin: completeSsoLogin,

		refreshSession:        refreshSession,
		updateSsoGroupMapping: updateSsoGroupMapping,
		listSsoGroupMapping:   listSsoGroupMapping,
	}
}

func (s *Server) Login(ctx context.Context, req *authv1.LoginRequest) (*authv1.LoginResponse, error) {
	out, err := s.login.Execute(ctx, usecase.LoginInput{Email: req.GetEmail(), Password: req.GetPassword()})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &authv1.LoginResponse{SessionToken: out.SessionToken, RefreshToken: out.RefreshToken, User: toProtoUser(out.User)}, nil
}

func (s *Server) Logout(ctx context.Context, req *authv1.LogoutRequest) (*authv1.LogoutResponse, error) {
	if err := s.logout.Execute(ctx, req.GetSessionToken()); err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &authv1.LogoutResponse{}, nil
}

func (s *Server) ValidateSession(ctx context.Context, req *authv1.ValidateSessionRequest) (*authv1.ValidateSessionResponse, error) {
	out, err := s.validateSession.Execute(ctx, req.GetSessionToken())
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	resp := &authv1.ValidateSessionResponse{Valid: out.Valid}
	if out.Valid {
		resp.User = toProtoUser(out.User)
	}
	return resp, nil
}

// IssueServiceToken mints a real RS256 JWT, signed through Vault Transit
// (internal/adapter/vault.TokenSigner) — the private key never materializes
// in this service's process memory. See this service's README "Known gaps"
// for what's still not covered (the fuller IssueToken/RefreshToken/
// RevokeToken surface — caller-authorization itself is now covered, see
// usecase.IssueServiceTokenInput.CallerUserID's doc comment,
// CR-CLI-002/TASK-BE-CLI-004).
//
// CallerUserID comes from tenant.UserID(ctx), NEVER from a request field —
// populated by grpcmw.TenantExtractionInterceptor (wired in this service's
// ChainUnary) from the x-orca-user-id metadata api-gateway's
// gatewaygrpc.AttachIdentity sets on every outbound call. This is the same
// existing propagation mechanism requireAdminActor (authorization.go) already
// relies on for admin checks — reused here, not a new interceptor.
func (s *Server) IssueServiceToken(ctx context.Context, req *authv1.IssueServiceTokenRequest) (*authv1.IssueServiceTokenResponse, error) {
	callerUserID, _ := tenant.UserID(ctx)
	out, err := s.issueServiceToken.Execute(ctx, usecase.IssueServiceTokenInput{
		UserID:       req.GetUserId(),
		Audience:     req.GetAudience(),
		CallerUserID: callerUserID,
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &authv1.IssueServiceTokenResponse{
		Jwt:       out.JWT,
		ExpiresAt: timestamppb.New(out.ExpiresAt),
	}, nil
}

// GetJWKS is public/unauthenticated by convention (see
// proto/orca/auth/v1/auth.proto's doc comment on the RPC) — no actor
// resolution here, unlike every admin-console handler above.
func (s *Server) GetJWKS(ctx context.Context, req *authv1.GetJWKSRequest) (*authv1.GetJWKSResponse, error) {
	out, err := s.getJWKS.Execute(ctx)
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &authv1.GetJWKSResponse{JwksJson: out.JWKSJSON}, nil
}

// IsServiceTokenRevoked backs api-gateway's per-request revocation check —
// see usecase.IsServiceTokenRevoked's doc comment for why this RPC has no
// caller-identity gate.
func (s *Server) IsServiceTokenRevoked(ctx context.Context, req *authv1.IsServiceTokenRevokedRequest) (*authv1.IsServiceTokenRevokedResponse, error) {
	revoked, err := s.isServiceTokenRevoked.Execute(ctx, req.GetJti())
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &authv1.IsServiceTokenRevokedResponse{Revoked: revoked}, nil
}

// ListCliTokens/RevokeCliToken are self-service only — CallerUserID comes
// from tenant.UserID(ctx), the same propagation mechanism IssueServiceToken
// uses (see that handler's doc comment); UserID comes from the request
// field api-gateway's route sets from identity.UserID, never a client-
// controlled value, but the usecase re-verifies the two match rather than
// trusting the request field alone (CR-CLI-002/TASK-BE-CLI-004's "never
// trust identity from a request field" rule applied to these sibling RPCs).
func (s *Server) ListCliTokens(ctx context.Context, req *authv1.ListCliTokensRequest) (*authv1.ListCliTokensResponse, error) {
	callerUserID, _ := tenant.UserID(ctx)
	tokens, err := s.listCliTokens.Execute(ctx, usecase.ListCliTokensInput{
		UserID:       req.GetUserId(),
		CallerUserID: callerUserID,
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	out := make([]*authv1.CliToken, 0, len(tokens))
	for _, t := range tokens {
		ct := &authv1.CliToken{
			Jti:       t.JTI,
			Audience:  t.Audience,
			IssuedAt:  timestamppb.New(t.IssuedAt),
			ExpiresAt: timestamppb.New(t.ExpiresAt),
		}
		if t.RevokedAt != nil {
			ct.RevokedAt = timestamppb.New(*t.RevokedAt)
		}
		out = append(out, ct)
	}
	return &authv1.ListCliTokensResponse{Tokens: out}, nil
}

func (s *Server) RevokeCliToken(ctx context.Context, req *authv1.RevokeCliTokenRequest) (*emptypb.Empty, error) {
	callerUserID, _ := tenant.UserID(ctx)
	if err := s.revokeCliToken.Execute(ctx, usecase.RevokeCliTokenInput{
		JTI:          req.GetJti(),
		UserID:       req.GetUserId(),
		CallerUserID: callerUserID,
	}); err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &emptypb.Empty{}, nil
}

func (s *Server) CreateUser(ctx context.Context, req *authv1.CreateUserRequest) (*authv1.CreateUserResponse, error) {
	out, err := s.createUser.Execute(ctx, usecase.CreateUserInput{
		Email:    req.GetEmail(),
		Name:     req.GetName(),
		TenantID: req.GetTenantId(),
		Role:     toDomainRole(req.GetRole()),
		Password: req.GetPassword(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &authv1.CreateUserResponse{User: toProtoUser(out.User), GeneratedPassword: out.GeneratedPassword}, nil
}

func (s *Server) ListUsers(ctx context.Context, req *authv1.ListUsersRequest) (*authv1.ListUsersResponse, error) {
	out, err := s.listUsers.Execute(ctx, usecase.ListUsersInput{
		TenantID:  req.GetTenantId(),
		PageToken: req.GetPageToken(),
		PageSize:  req.GetPageSize(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	users := make([]*authv1.User, 0, len(out.Users))
	for _, u := range out.Users {
		users = append(users, toProtoUser(u))
	}
	return &authv1.ListUsersResponse{Users: users, NextPageToken: out.NextPageToken}, nil
}

func (s *Server) ListTenantMemberDirectory(ctx context.Context, _ *authv1.ListTenantMemberDirectoryRequest) (*authv1.ListTenantMemberDirectoryResponse, error) {
	entries, err := s.listTenantMemberDirectory.Execute(ctx)
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	members := make([]*authv1.TenantMemberDirectoryEntry, 0, len(entries))
	for _, e := range entries {
		members = append(members, &authv1.TenantMemberDirectoryEntry{Id: e.ID, Name: e.Name, Email: e.Email})
	}
	return &authv1.ListTenantMemberDirectoryResponse{Members: members}, nil
}

func (s *Server) UpdateUserRole(ctx context.Context, req *authv1.UpdateUserRoleRequest) (*authv1.UpdateUserRoleResponse, error) {
	user, err := s.updateUserRole.Execute(ctx, req.GetUserId(), toDomainRole(req.GetRole()))
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &authv1.UpdateUserRoleResponse{User: toProtoUser(user)}, nil
}

func (s *Server) RevokeSession(ctx context.Context, req *authv1.RevokeSessionRequest) (*authv1.RevokeSessionResponse, error) {
	if err := s.revokeSession.Execute(ctx, req.GetSessionToken()); err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &authv1.RevokeSessionResponse{}, nil
}

func (s *Server) QueryAuditLog(ctx context.Context, req *authv1.QueryAuditLogRequest) (*authv1.QueryAuditLogResponse, error) {
	out, err := s.queryAuditLog.Execute(ctx, usecase.QueryAuditLogInput{
		TenantID:  req.GetTenantId(),
		Since:     toTime(req.GetSince()),
		ActorID:   req.GetActorId(),
		Action:    req.GetAction(),
		Outcome:   domain.Outcome(req.GetOutcome()),
		PageToken: req.GetPageToken(),
		PageSize:  req.GetPageSize(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	entries := make([]*authv1.AuditEntry, 0, len(out.Entries))
	for _, e := range out.Entries {
		entries = append(entries, toProtoAuditEntry(e))
	}
	return &authv1.QueryAuditLogResponse{Entries: entries, NextPageToken: out.NextPageToken}, nil
}

// AppendAuditEntry is the cross-service audit-ingress RPC (TASK-BE-017) —
// deliberately no requireAdminActor-style gate, see
// usecase.AppendAuditEntry's doc comment.
func (s *Server) AppendAuditEntry(ctx context.Context, req *authv1.AppendAuditEntryRequest) (*emptypb.Empty, error) {
	if err := s.appendAuditEntry.Execute(ctx, usecase.AppendAuditEntryInput{
		TenantID:  req.GetTenantId(),
		ActorID:   req.GetActorId(),
		Action:    req.GetAction(),
		Target:    req.GetTarget(),
		Outcome:   req.GetOutcome(),
		IPAddress: req.GetIpAddress(),
	}); err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &emptypb.Empty{}, nil
}

func (s *Server) DeactivateUser(ctx context.Context, req *authv1.DeactivateUserRequest) (*authv1.DeactivateUserResponse, error) {
	user, err := s.deactivateUser.Execute(ctx, req.GetUserId())
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &authv1.DeactivateUserResponse{User: toProtoUser(user)}, nil
}

func (s *Server) ReactivateUser(ctx context.Context, req *authv1.ReactivateUserRequest) (*authv1.ReactivateUserResponse, error) {
	user, err := s.reactivateUser.Execute(ctx, req.GetUserId())
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &authv1.ReactivateUserResponse{User: toProtoUser(user)}, nil
}

func (s *Server) ListSessionsForUser(ctx context.Context, req *authv1.ListSessionsForUserRequest) (*authv1.ListSessionsForUserResponse, error) {
	sessions, err := s.listSessionsForUser.Execute(ctx, req.GetUserId())
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	out := make([]*authv1.Session, 0, len(sessions))
	for _, sess := range sessions {
		out = append(out, toProtoSession(sess))
	}
	return &authv1.ListSessionsForUserResponse{Sessions: out}, nil
}

func (s *Server) ForceRevokeAllSessionsForUser(ctx context.Context, req *authv1.ForceRevokeAllSessionsForUserRequest) (*authv1.ForceRevokeAllSessionsForUserResponse, error) {
	revoked, err := s.forceRevokeAllSessionsForUser.Execute(ctx, req.GetUserId())
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &authv1.ForceRevokeAllSessionsForUserResponse{RevokedCount: revoked}, nil
}

func (s *Server) ForceRevokeSession(ctx context.Context, req *authv1.ForceRevokeSessionRequest) (*emptypb.Empty, error) {
	if err := s.forceRevokeSession.Execute(ctx, req.GetSessionId()); err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &emptypb.Empty{}, nil
}

func (s *Server) CreateAccessPolicy(ctx context.Context, req *authv1.CreateAccessPolicyRequest) (*authv1.AccessPolicy, error) {
	policy, err := s.createAccessPolicy.Execute(ctx, usecase.CreateAccessPolicyInput{
		Name:         req.GetName(),
		Kind:         req.GetKind(),
		DocumentJSON: req.GetDocumentJson(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return toProtoAccessPolicy(policy), nil
}

func (s *Server) GetAccessPolicy(ctx context.Context, req *authv1.GetAccessPolicyRequest) (*authv1.AccessPolicy, error) {
	policy, err := s.getAccessPolicy.Execute(ctx, req.GetId())
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return toProtoAccessPolicy(policy), nil
}

func (s *Server) ListAccessPolicies(ctx context.Context, req *authv1.ListAccessPoliciesRequest) (*authv1.ListAccessPoliciesResponse, error) {
	out, err := s.listAccessPolicies.Execute(ctx, usecase.ListAccessPoliciesInput{
		PageToken: req.GetPageToken(),
		PageSize:  req.GetPageSize(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	policies := make([]*authv1.AccessPolicy, 0, len(out.Policies))
	for _, p := range out.Policies {
		policies = append(policies, toProtoAccessPolicy(p))
	}
	return &authv1.ListAccessPoliciesResponse{Policies: policies, NextPageToken: out.NextPageToken}, nil
}

func (s *Server) UpdateAccessPolicy(ctx context.Context, req *authv1.UpdateAccessPolicyRequest) (*authv1.AccessPolicy, error) {
	policy, err := s.updateAccessPolicy.Execute(ctx, req.GetId(), req.GetDocumentJson(), req.GetExpectedVersion())
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return toProtoAccessPolicy(policy), nil
}

func (s *Server) DeleteAccessPolicy(ctx context.Context, req *authv1.DeleteAccessPolicyRequest) (*emptypb.Empty, error) {
	if err := s.deleteAccessPolicy.Execute(ctx, req.GetId()); err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &emptypb.Empty{}, nil
}

func (s *Server) GetAdminStats(ctx context.Context, req *authv1.GetAdminStatsRequest) (*authv1.GetAdminStatsResponse, error) {
	stats, err := s.getAdminStats.Execute(ctx)
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &authv1.GetAdminStatsResponse{
		TotalUsers:     stats.TotalUsers,
		ActiveSessions: stats.ActiveSessions,
		TotalPolicies:  stats.TotalPolicies,
	}, nil
}

// StartSsoLogin/CompleteSsoLogin are unauthenticated by necessity — like
// Login, the caller has no session yet. api-gateway's GET /auth/sso/
// {provider} and GET /auth/callback are the only callers (see
// auth.proto's doc comment on the RPC).
func (s *Server) StartSsoLogin(ctx context.Context, req *authv1.StartSsoLoginRequest) (*authv1.StartSsoLoginResponse, error) {
	out, err := s.startSsoLogin.Execute(ctx, usecase.StartSsoLoginInput{
		Provider:    domain.SsoProvider(req.GetProvider()),
		RedirectURI: req.GetRedirectUri(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &authv1.StartSsoLoginResponse{AuthorizationUrl: out.AuthorizationURL, State: out.State}, nil
}

func (s *Server) CompleteSsoLogin(ctx context.Context, req *authv1.CompleteSsoLoginRequest) (*authv1.CompleteSsoLoginResponse, error) {
	out, err := s.completeSsoLogin.Execute(ctx, usecase.CompleteSsoLoginInput{
		Code:  req.GetCode(),
		State: req.GetState(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &authv1.CompleteSsoLoginResponse{SessionToken: out.SessionToken, RefreshToken: out.RefreshToken, User: toProtoUser(out.User)}, nil
}

// RefreshSession is unauthenticated by necessity — like Login, the caller
// proves identity with a refresh token, not an existing valid session (see
// auth.proto's doc comment on the RPC).
func (s *Server) RefreshSession(ctx context.Context, req *authv1.RefreshSessionRequest) (*authv1.RefreshSessionResponse, error) {
	out, err := s.refreshSession.Execute(ctx, usecase.RefreshSessionInput{RefreshToken: req.GetRefreshToken()})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &authv1.RefreshSessionResponse{
		SessionToken: out.SessionToken,
		ExpiresAt:    timestamppb.New(out.ExpiresAt),
		// RefreshToken: the NEW rotated refresh token — TASK-BE-011 originally
		// omitted this, making a second refresh impossible. See RefreshSessionResponse's
		// proto doc comment (TASK-BE-012).
		RefreshToken: out.RefreshToken,
	}, nil
}

func (s *Server) UpdateSsoGroupMapping(ctx context.Context, req *authv1.UpdateSsoGroupMappingRequest) (*authv1.UpdateSsoGroupMappingResponse, error) {
	mapping, err := s.updateSsoGroupMapping.Execute(ctx, usecase.UpdateSsoGroupMappingInput{
		TenantID:  req.GetTenantId(),
		Provider:  domain.SsoProvider(req.GetProvider()),
		GroupName: req.GetGroupName(),
		Role:      toDomainRole(req.GetRole()),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &authv1.UpdateSsoGroupMappingResponse{Mapping: toProtoSsoGroupRoleMapping(mapping)}, nil
}

func (s *Server) ListSsoGroupMapping(ctx context.Context, req *authv1.ListSsoGroupMappingRequest) (*authv1.ListSsoGroupMappingResponse, error) {
	out, err := s.listSsoGroupMapping.Execute(ctx, usecase.ListSsoGroupMappingInput{
		TenantID: req.GetTenantId(),
		Provider: domain.SsoProvider(req.GetProvider()),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	mappings := make([]*authv1.SsoGroupRoleMapping, 0, len(out))
	for _, m := range out {
		mappings = append(mappings, toProtoSsoGroupRoleMapping(m))
	}
	return &authv1.ListSsoGroupMappingResponse{Mappings: mappings}, nil
}

func toProtoSsoGroupRoleMapping(m domain.SsoGroupRoleMapping) *authv1.SsoGroupRoleMapping {
	out := &authv1.SsoGroupRoleMapping{
		Id:        m.ID,
		Provider:  string(m.Provider),
		GroupName: m.GroupName,
		Role:      toProtoRole(m.Role),
	}
	if !m.CreatedAt.IsZero() {
		out.CreatedAt = timestamppb.New(m.CreatedAt)
	}
	return out
}

func toProtoSession(s domain.Session) *authv1.Session {
	out := &authv1.Session{
		Id:     s.TokenHash,
		UserId: s.UserID,
	}
	if !s.CreatedAt.IsZero() {
		out.CreatedAt = timestamppb.New(s.CreatedAt)
	}
	if !s.ExpiresAt.IsZero() {
		out.ExpiresAt = timestamppb.New(s.ExpiresAt)
	}
	return out
}

func toProtoAccessPolicy(p domain.AccessPolicy) *authv1.AccessPolicy {
	out := &authv1.AccessPolicy{
		Id:           p.ID,
		Name:         p.Name,
		Kind:         p.Kind,
		DocumentJson: p.DocumentJSON,
		Version:      p.Version,
		UpdatedBy:    p.UpdatedBy,
	}
	if !p.UpdatedAt.IsZero() {
		out.UpdatedAt = timestamppb.New(p.UpdatedAt)
	}
	return out
}

func toDomainRole(r authv1.Role) domain.Role {
	switch r {
	case authv1.Role_ROLE_USER:
		return domain.RoleUser
	case authv1.Role_ROLE_ADMIN:
		return domain.RoleAdmin
	default:
		return ""
	}
}

func toProtoRole(r domain.Role) authv1.Role {
	switch r {
	case domain.RoleUser:
		return authv1.Role_ROLE_USER
	case domain.RoleAdmin:
		return authv1.Role_ROLE_ADMIN
	default:
		return authv1.Role_ROLE_UNSPECIFIED
	}
}

func toTime(ts *timestamppb.Timestamp) time.Time {
	if ts == nil {
		return time.Time{}
	}
	return ts.AsTime()
}

func toProtoUser(u domain.User) *authv1.User {
	// "none" for a local-password-only account (u.SsoProvider's zero
	// value) — see domain.User.SsoProvider's doc comment.
	provider := "none"
	if u.SsoProvider != "" {
		provider = string(u.SsoProvider)
	}
	out := &authv1.User{
		Id:       u.ID,
		TenantId: u.TenantID,
		Email:    u.Email,
		Name:     u.Name,
		Role:     toProtoRole(u.Role),
		IsActive: u.IsActive,
		Provider: provider,
	}
	if !u.CreatedAt.IsZero() {
		out.CreatedAt = timestamppb.New(u.CreatedAt)
	}
	return out
}

func toProtoAuditEntry(e domain.AuditEntry) *authv1.AuditEntry {
	out := &authv1.AuditEntry{
		Id:        e.ID,
		TenantId:  e.TenantID,
		ActorId:   e.ActorID,
		Action:    e.Action,
		Target:    e.Target,
		Outcome:   string(e.Outcome),
		IpAddress: e.IPAddress,
	}
	if !e.OccurredAt.IsZero() {
		out.OccurredAt = timestamppb.New(e.OccurredAt)
	}
	return out
}
