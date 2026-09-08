// Package grpc implements the generated tenantv1.TenantServiceServer
// interface by translating wire messages to/from usecase calls — no
// business logic here, per
// specs/backend-go/architecture/03-clean-architecture-guidelines.md's
// inbound-adapter contract.
package grpc

import (
	"context"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/services/tenant-service/internal/domain"
	"github.com/stablyai/orca-go/services/tenant-service/internal/usecase"

	tenantv1 "github.com/stablyai/orca-go/proto/gen/go/orca/tenant/v1"

	"google.golang.org/protobuf/types/known/emptypb"
)

// ResolvedProfileGetter is satisfied by both usecase.GetResolvedProfile and
// its usecase.CachedGetResolvedProfile decorator — the gRPC layer doesn't
// care which one the composition root (cmd/server/main.go) wires in
// (tenant-service.md §6).
type ResolvedProfileGetter interface {
	Execute(ctx context.Context, userID string) (domain.ResolvedProfile, error)
}

// Server implements tenantv1.UnimplementedTenantServiceServer.
type Server struct {
	tenantv1.UnimplementedTenantServiceServer

	createCompany      *usecase.CreateCompany
	getCompany         *usecase.GetCompany
	listCompanies      *usecase.ListCompanies
	validateTenant     *usecase.ValidateTenant
	createDepartment   *usecase.CreateDepartment
	setUserDepartment  *usecase.SetUserDepartment
	getResolvedProfile ResolvedProfileGetter
	createTeam         *usecase.CreateTeam
	addTeamMember      *usecase.AddTeamMember
	listTeamMembers    *usecase.ListTeamMembers
	getUserProfile     *usecase.GetUserProfile
	listDepartments    *usecase.ListDepartments
	updateCompany      *usecase.UpdateCompany
	updateDepartment   *usecase.UpdateDepartment
	updateUserProfile  *usecase.UpdateUserProfile
	listTeams          *usecase.ListTeams
	listTeamsForUser   *usecase.ListTeamsForUser
	removeTeamMember   *usecase.RemoveTeamMember
	getOnboardingState *usecase.GetOnboardingState
	setOnboardingState *usecase.SetOnboardingState

	addCompanyEmailDomain       *usecase.AddCompanyEmailDomain
	removeCompanyEmailDomain    *usecase.RemoveCompanyEmailDomain
	listCompanyEmailDomains     *usecase.ListCompanyEmailDomains
	resolveCompanyByEmailDomain *usecase.ResolveCompanyByEmailDomain

	getClientState        *usecase.GetClientState
	setClientState        *usecase.SetClientState
	getWorkspaceSession   *usecase.GetWorkspaceSession
	setWorkspaceSession   *usecase.SetWorkspaceSession
	patchWorkspaceSession *usecase.PatchWorkspaceSession

	deferStarNag                        *usecase.DeferStarNag
	completeStarNag                     *usecase.CompleteStarNag
	disableStarNag                      *usecase.DisableStarNag
	forceShowStarNag                    *usecase.ForceShowStarNag
	notifyStarNagOnboardingCompleted    *usecase.NotifyStarNagOnboardingCompleted
	openWebStarNag                      *usecase.OpenWebStarNag
	starOrcaFromNag                     *usecase.StarOrcaFromNag
	prepareStarNagAgentValueMoment      *usecase.PrepareStarNagAgentValueMoment
	showPreparedStarNagAgentValueMoment *usecase.ShowPreparedStarNagAgentValueMoment
}

func New(
	createCompany *usecase.CreateCompany,
	getCompany *usecase.GetCompany,
	listCompanies *usecase.ListCompanies,
	validateTenant *usecase.ValidateTenant,
	createDepartment *usecase.CreateDepartment,
	setUserDepartment *usecase.SetUserDepartment,
	getResolvedProfile ResolvedProfileGetter,
	createTeam *usecase.CreateTeam,
	addTeamMember *usecase.AddTeamMember,
	listTeamMembers *usecase.ListTeamMembers,
	getUserProfile *usecase.GetUserProfile,
	listDepartments *usecase.ListDepartments,
	updateCompany *usecase.UpdateCompany,
	updateDepartment *usecase.UpdateDepartment,
	updateUserProfile *usecase.UpdateUserProfile,
	listTeams *usecase.ListTeams,
	listTeamsForUser *usecase.ListTeamsForUser,
	removeTeamMember *usecase.RemoveTeamMember,
	getOnboardingState *usecase.GetOnboardingState,
	setOnboardingState *usecase.SetOnboardingState,
	addCompanyEmailDomain *usecase.AddCompanyEmailDomain,
	removeCompanyEmailDomain *usecase.RemoveCompanyEmailDomain,
	listCompanyEmailDomains *usecase.ListCompanyEmailDomains,
	resolveCompanyByEmailDomain *usecase.ResolveCompanyByEmailDomain,
	getClientState *usecase.GetClientState,
	setClientState *usecase.SetClientState,
	getWorkspaceSession *usecase.GetWorkspaceSession,
	setWorkspaceSession *usecase.SetWorkspaceSession,
	patchWorkspaceSession *usecase.PatchWorkspaceSession,
	deferStarNag *usecase.DeferStarNag,
	completeStarNag *usecase.CompleteStarNag,
	disableStarNag *usecase.DisableStarNag,
	forceShowStarNag *usecase.ForceShowStarNag,
	notifyStarNagOnboardingCompleted *usecase.NotifyStarNagOnboardingCompleted,
	openWebStarNag *usecase.OpenWebStarNag,
	starOrcaFromNag *usecase.StarOrcaFromNag,
	prepareStarNagAgentValueMoment *usecase.PrepareStarNagAgentValueMoment,
	showPreparedStarNagAgentValueMoment *usecase.ShowPreparedStarNagAgentValueMoment,
) *Server {
	return &Server{
		createCompany:      createCompany,
		getCompany:         getCompany,
		listCompanies:      listCompanies,
		validateTenant:     validateTenant,
		createDepartment:   createDepartment,
		setUserDepartment:  setUserDepartment,
		getResolvedProfile: getResolvedProfile,
		createTeam:         createTeam,
		addTeamMember:      addTeamMember,
		listTeamMembers:    listTeamMembers,
		getUserProfile:     getUserProfile,
		listDepartments:    listDepartments,
		updateCompany:      updateCompany,
		updateDepartment:   updateDepartment,
		updateUserProfile:  updateUserProfile,
		listTeams:          listTeams,
		listTeamsForUser:   listTeamsForUser,
		removeTeamMember:   removeTeamMember,
		getOnboardingState: getOnboardingState,
		setOnboardingState: setOnboardingState,

		addCompanyEmailDomain:       addCompanyEmailDomain,
		removeCompanyEmailDomain:    removeCompanyEmailDomain,
		listCompanyEmailDomains:     listCompanyEmailDomains,
		resolveCompanyByEmailDomain: resolveCompanyByEmailDomain,

		getClientState:        getClientState,
		setClientState:        setClientState,
		getWorkspaceSession:   getWorkspaceSession,
		setWorkspaceSession:   setWorkspaceSession,
		patchWorkspaceSession: patchWorkspaceSession,

		deferStarNag:                        deferStarNag,
		completeStarNag:                     completeStarNag,
		disableStarNag:                      disableStarNag,
		forceShowStarNag:                    forceShowStarNag,
		notifyStarNagOnboardingCompleted:    notifyStarNagOnboardingCompleted,
		openWebStarNag:                      openWebStarNag,
		starOrcaFromNag:                     starOrcaFromNag,
		prepareStarNagAgentValueMoment:      prepareStarNagAgentValueMoment,
		showPreparedStarNagAgentValueMoment: showPreparedStarNagAgentValueMoment,
	}
}

func (s *Server) CreateCompany(ctx context.Context, req *tenantv1.CreateCompanyRequest) (*tenantv1.CreateCompanyResponse, error) {
	company, err := s.createCompany.Execute(ctx, usecase.CreateCompanyInput{Name: req.GetName()})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	proto, err := toProtoCompany(company)
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &tenantv1.CreateCompanyResponse{Company: proto}, nil
}

func (s *Server) GetCompany(ctx context.Context, req *tenantv1.GetCompanyRequest) (*tenantv1.GetCompanyResponse, error) {
	company, err := s.getCompany.Execute(ctx, req.GetId())
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	proto, err := toProtoCompany(company)
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &tenantv1.GetCompanyResponse{Company: proto}, nil
}

func (s *Server) ListCompanies(ctx context.Context, req *tenantv1.ListCompaniesRequest) (*tenantv1.ListCompaniesResponse, error) {
	companies, err := s.listCompanies.Execute(ctx)
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	protoCompanies := make([]*tenantv1.Company, 0, len(companies))
	for _, c := range companies {
		proto, err := toProtoCompany(c)
		if err != nil {
			return nil, apperrors.ToGRPCStatus(err)
		}
		protoCompanies = append(protoCompanies, proto)
	}
	return &tenantv1.ListCompaniesResponse{Companies: protoCompanies}, nil
}

func (s *Server) GetOnboardingState(ctx context.Context, req *tenantv1.GetOnboardingStateRequest) (*tenantv1.GetOnboardingStateResponse, error) {
	result, err := s.getOnboardingState.Execute(ctx, req.GetUserId())
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &tenantv1.GetOnboardingStateResponse{StateJson: result.StateJSON, Found: result.Found}, nil
}

func (s *Server) SetOnboardingState(ctx context.Context, req *tenantv1.SetOnboardingStateRequest) (*emptypb.Empty, error) {
	err := s.setOnboardingState.Execute(ctx, usecase.SetOnboardingStateInput{
		UserID:    req.GetUserId(),
		StateJSON: req.GetStateJson(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &emptypb.Empty{}, nil
}

// ── Client-local state / workspace session handlers (CR-STORAGE-001/003/
// 004a,b) ──────────────────────────────────────────────────────────────
//
// Security note: every handler below scopes by req.GetUserId() exactly as
// GetOnboardingState/SetOnboardingState above already do — company_id is
// NEVER read from the request (there is no such field), only from
// tenant.RequireTenantID(ctx) inside the usecase, populated by the gRPC
// tenant-extraction interceptor from the authenticated caller's identity.

func clientStateKindFromProto(kind tenantv1.ClientStateKind) usecase.ClientStateKind {
	switch kind {
	case tenantv1.ClientStateKind_CLIENT_STATE_KIND_KEYBINDINGS:
		return usecase.ClientStateKindKeybindings
	case tenantv1.ClientStateKind_CLIENT_STATE_KIND_UI_LOCAL:
		return usecase.ClientStateKindUILocal
	case tenantv1.ClientStateKind_CLIENT_STATE_KIND_SAVED_RUNTIME_ENVIRONMENTS:
		return usecase.ClientStateKindSavedRuntimeEnvironments
	case tenantv1.ClientStateKind_CLIENT_STATE_KIND_SETTINGS:
		return usecase.ClientStateKindSettings
	case tenantv1.ClientStateKind_CLIENT_STATE_KIND_ACCOUNTS_DEV_SERVER_MAP:
		return usecase.ClientStateKindAccountsDevServerMap
	default:
		// Deliberately not a real kind — GetClientState/SetClientState's own
		// columnForKind switch rejects this as TENANT_UNKNOWN_CLIENT_STATE_KIND,
		// same defense-in-depth double-whitelist as adapter/postgres's
		// columnNameFor.
		return usecase.ClientStateKind("")
	}
}

func (s *Server) GetClientState(ctx context.Context, req *tenantv1.GetClientStateRequest) (*tenantv1.GetClientStateResponse, error) {
	result, err := s.getClientState.Execute(ctx, req.GetUserId(), clientStateKindFromProto(req.GetKind()))
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &tenantv1.GetClientStateResponse{StateJson: result.StateJSON, Found: result.Found}, nil
}

func (s *Server) SetClientState(ctx context.Context, req *tenantv1.SetClientStateRequest) (*emptypb.Empty, error) {
	err := s.setClientState.Execute(ctx, usecase.SetClientStateInput{
		UserID:    req.GetUserId(),
		Kind:      clientStateKindFromProto(req.GetKind()),
		StateJSON: req.GetStateJson(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &emptypb.Empty{}, nil
}

func (s *Server) GetWorkspaceSession(ctx context.Context, req *tenantv1.GetWorkspaceSessionRequest) (*tenantv1.GetWorkspaceSessionResponse, error) {
	result, err := s.getWorkspaceSession.Execute(ctx, req.GetUserId(), req.GetHostId())
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &tenantv1.GetWorkspaceSessionResponse{SessionJson: result.SessionJSON, Found: result.Found}, nil
}

func (s *Server) SetWorkspaceSession(ctx context.Context, req *tenantv1.SetWorkspaceSessionRequest) (*emptypb.Empty, error) {
	err := s.setWorkspaceSession.Execute(ctx, usecase.SetWorkspaceSessionInput{
		UserID:      req.GetUserId(),
		HostID:      req.GetHostId(),
		SessionJSON: req.GetSessionJson(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &emptypb.Empty{}, nil
}

func (s *Server) PatchWorkspaceSession(ctx context.Context, req *tenantv1.PatchWorkspaceSessionRequest) (*emptypb.Empty, error) {
	err := s.patchWorkspaceSession.Execute(ctx, usecase.PatchWorkspaceSessionInput{
		UserID:    req.GetUserId(),
		HostID:    req.GetHostId(),
		PatchJSON: req.GetPatchJson(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &emptypb.Empty{}, nil
}

func (s *Server) ValidateTenant(ctx context.Context, req *tenantv1.ValidateTenantRequest) (*tenantv1.ValidateTenantResponse, error) {
	exists, err := s.validateTenant.Execute(ctx, usecase.ValidateTenantInput{TenantID: req.GetTenantId()})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &tenantv1.ValidateTenantResponse{Exists: exists}, nil
}

func (s *Server) CreateDepartment(ctx context.Context, req *tenantv1.CreateDepartmentRequest) (*tenantv1.CreateDepartmentResponse, error) {
	department, err := s.createDepartment.Execute(ctx, usecase.CreateDepartmentInput{
		CompanyID: req.GetCompanyId(),
		Name:      req.GetName(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	proto, err := toProtoDepartment(department)
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &tenantv1.CreateDepartmentResponse{Department: proto}, nil
}

func (s *Server) SetUserDepartment(ctx context.Context, req *tenantv1.SetUserDepartmentRequest) (*tenantv1.SetUserDepartmentResponse, error) {
	err := s.setUserDepartment.Execute(ctx, usecase.SetUserDepartmentInput{
		UserID:       req.GetUserId(),
		DepartmentID: req.GetDepartmentId(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &tenantv1.SetUserDepartmentResponse{}, nil
}

func (s *Server) GetResolvedProfile(ctx context.Context, req *tenantv1.GetResolvedProfileRequest) (*tenantv1.GetResolvedProfileResponse, error) {
	resolved, err := s.getResolvedProfile.Execute(ctx, req.GetUserId())
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	settingsJSON, err := marshalSettings(resolved.Settings)
	if err != nil {
		return nil, apperrors.ToGRPCStatus(apperrors.New(apperrors.KindInternal, "TENANT_MARSHAL_PROFILE_FAILED", "failed to marshal resolved profile", err))
	}
	return &tenantv1.GetResolvedProfileResponse{ResolvedSettingsJson: settingsJSON}, nil
}

func (s *Server) CreateTeam(ctx context.Context, req *tenantv1.CreateTeamRequest) (*tenantv1.CreateTeamResponse, error) {
	settings, err := unmarshalSettings(req.GetSettingsJson())
	if err != nil {
		return nil, apperrors.ToGRPCStatus(apperrors.New(apperrors.KindInvalidArgument, "TENANT_INVALID_TEAM_SETTINGS", "settings_json is not valid JSON", err))
	}
	team, err := s.createTeam.Execute(ctx, usecase.CreateTeamInput{
		CompanyID: req.GetCompanyId(),
		Name:      req.GetName(),
		Settings:  settings,
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	proto, err := toProtoTeam(team)
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &tenantv1.CreateTeamResponse{Team: proto}, nil
}

func (s *Server) AddTeamMember(ctx context.Context, req *tenantv1.AddTeamMemberRequest) (*tenantv1.AddTeamMemberResponse, error) {
	_, err := s.addTeamMember.Execute(ctx, usecase.AddTeamMemberInput{
		TeamID:   req.GetTeamId(),
		UserID:   req.GetUserId(),
		Priority: req.GetPriority(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &tenantv1.AddTeamMemberResponse{}, nil
}

func (s *Server) ListTeamMembers(ctx context.Context, req *tenantv1.ListTeamMembersRequest) (*tenantv1.ListTeamMembersResponse, error) {
	members, err := s.listTeamMembers.Execute(ctx, usecase.ListTeamMembersInput{TeamID: req.GetTeamId()})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	out := make([]*tenantv1.TeamMember, 0, len(members))
	for _, m := range members {
		out = append(out, &tenantv1.TeamMember{UserId: m.UserID, Priority: m.Priority})
	}
	return &tenantv1.ListTeamMembersResponse{Members: out}, nil
}

func (s *Server) GetUserProfile(ctx context.Context, req *tenantv1.GetUserProfileRequest) (*tenantv1.GetUserProfileResponse, error) {
	profile, err := s.getUserProfile.Execute(ctx, usecase.GetUserProfileInput{UserID: req.GetUserId()})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	proto, err := toProtoUserProfile(profile)
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &tenantv1.GetUserProfileResponse{Profile: proto}, nil
}

func (s *Server) ListDepartments(ctx context.Context, req *tenantv1.ListDepartmentsRequest) (*tenantv1.ListDepartmentsResponse, error) {
	depts, err := s.listDepartments.Execute(ctx, usecase.ListDepartmentsInput{CompanyID: req.GetCompanyId()})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	out := make([]*tenantv1.Department, 0, len(depts))
	for _, d := range depts {
		proto, err := toProtoDepartment(d)
		if err != nil {
			return nil, apperrors.ToGRPCStatus(err)
		}
		out = append(out, proto)
	}
	return &tenantv1.ListDepartmentsResponse{Departments: out}, nil
}

func (s *Server) UpdateCompany(ctx context.Context, req *tenantv1.UpdateCompanyRequest) (*tenantv1.UpdateCompanyResponse, error) {
	company, err := s.updateCompany.Execute(ctx, usecase.UpdateCompanyInput{
		ID: req.GetId(),
		Patch: domain.CompanySettingsPatch{
			Name:         req.GetName(),
			SettingsJSON: req.GetSettingsJson(),
		},
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	proto, err := toProtoCompany(company)
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &tenantv1.UpdateCompanyResponse{Company: proto}, nil
}

func (s *Server) UpdateDepartment(ctx context.Context, req *tenantv1.UpdateDepartmentRequest) (*tenantv1.UpdateDepartmentResponse, error) {
	dept, err := s.updateDepartment.Execute(ctx, usecase.UpdateDepartmentInput{
		ID: req.GetId(),
		Patch: domain.DepartmentSettingsPatch{
			Name:         req.GetName(),
			SettingsJSON: req.GetSettingsJson(),
		},
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	proto, err := toProtoDepartment(dept)
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &tenantv1.UpdateDepartmentResponse{Department: proto}, nil
}

func (s *Server) UpdateUserProfile(ctx context.Context, req *tenantv1.UpdateUserProfileRequest) (*tenantv1.UpdateUserProfileResponse, error) {
	in := usecase.UpdateUserProfileInput{
		UserID:          req.GetUserId(),
		DepartmentID:    req.GetDepartmentId(),
		ClearDepartment: req.GetClearDepartment(),
	}
	if req.GetSettingsJson() != "" {
		settings, err := unmarshalSettings(req.GetSettingsJson())
		if err != nil {
			return nil, apperrors.ToGRPCStatus(apperrors.New(apperrors.KindInvalidArgument, "TENANT_INVALID_PROFILE_SETTINGS", "settings_json is not valid JSON", err))
		}
		in.Settings = settings
		in.SetSettings = true
	}
	profile, err := s.updateUserProfile.Execute(ctx, in)
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	proto, err := toProtoUserProfile(profile)
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &tenantv1.UpdateUserProfileResponse{Profile: proto}, nil
}

func (s *Server) ListTeams(ctx context.Context, req *tenantv1.ListTeamsRequest) (*tenantv1.ListTeamsResponse, error) {
	teams, err := s.listTeams.Execute(ctx)
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	out := make([]*tenantv1.Team, 0, len(teams))
	for _, t := range teams {
		proto, err := toProtoTeam(t)
		if err != nil {
			return nil, apperrors.ToGRPCStatus(err)
		}
		out = append(out, proto)
	}
	return &tenantv1.ListTeamsResponse{Teams: out}, nil
}

func (s *Server) ListTeamsForUser(ctx context.Context, req *tenantv1.ListTeamsForUserRequest) (*tenantv1.ListTeamsForUserResponse, error) {
	teamIDs, err := s.listTeamsForUser.Execute(ctx, usecase.ListTeamsForUserInput{UserID: req.GetUserId()})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &tenantv1.ListTeamsForUserResponse{TeamIds: teamIDs}, nil
}

func (s *Server) RemoveTeamMember(ctx context.Context, req *tenantv1.RemoveTeamMemberRequest) (*emptypb.Empty, error) {
	err := s.removeTeamMember.Execute(ctx, usecase.RemoveTeamMemberInput{
		TeamID: req.GetTeamId(),
		UserID: req.GetUserId(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &emptypb.Empty{}, nil
}

func (s *Server) AddCompanyEmailDomain(ctx context.Context, req *tenantv1.AddCompanyEmailDomainRequest) (*tenantv1.AddCompanyEmailDomainResponse, error) {
	cd, err := s.addCompanyEmailDomain.Execute(ctx, usecase.AddCompanyEmailDomainInput{
		CompanyID:   req.GetCompanyId(),
		EmailDomain: req.GetEmailDomain(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &tenantv1.AddCompanyEmailDomainResponse{EmailDomain: cd.EmailDomain}, nil
}

func (s *Server) RemoveCompanyEmailDomain(ctx context.Context, req *tenantv1.RemoveCompanyEmailDomainRequest) (*emptypb.Empty, error) {
	err := s.removeCompanyEmailDomain.Execute(ctx, usecase.RemoveCompanyEmailDomainInput{EmailDomain: req.GetEmailDomain()})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &emptypb.Empty{}, nil
}

func (s *Server) ListCompanyEmailDomains(ctx context.Context, req *tenantv1.ListCompanyEmailDomainsRequest) (*tenantv1.ListCompanyEmailDomainsResponse, error) {
	domains, err := s.listCompanyEmailDomains.Execute(ctx, usecase.ListCompanyEmailDomainsInput{CompanyID: req.GetCompanyId()})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &tenantv1.ListCompanyEmailDomainsResponse{EmailDomains: domains}, nil
}

func (s *Server) ResolveCompanyByEmailDomain(ctx context.Context, req *tenantv1.ResolveCompanyByEmailDomainRequest) (*tenantv1.ResolveCompanyByEmailDomainResponse, error) {
	result, err := s.resolveCompanyByEmailDomain.Execute(ctx, usecase.ResolveCompanyByEmailDomainInput{EmailDomain: req.GetEmailDomain()})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &tenantv1.ResolveCompanyByEmailDomainResponse{CompanyId: result.CompanyID, Found: result.Found}, nil
}

// ── starNag.* handlers (BUG-005/SOL-005) ──────────────────────────────────

func (s *Server) DismissStarNag(ctx context.Context, req *tenantv1.DismissStarNagRequest) (*emptypb.Empty, error) {
	if err := s.deferStarNag.Execute(ctx, req.GetUserId()); err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &emptypb.Empty{}, nil
}

func (s *Server) DeferStarNag(ctx context.Context, req *tenantv1.DeferStarNagRequest) (*emptypb.Empty, error) {
	if err := s.deferStarNag.Execute(ctx, req.GetUserId()); err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &emptypb.Empty{}, nil
}

func (s *Server) CompleteStarNag(ctx context.Context, req *tenantv1.CompleteStarNagRequest) (*emptypb.Empty, error) {
	if err := s.completeStarNag.Execute(ctx, req.GetUserId()); err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &emptypb.Empty{}, nil
}

func (s *Server) DisableStarNag(ctx context.Context, req *tenantv1.DisableStarNagRequest) (*emptypb.Empty, error) {
	if err := s.disableStarNag.Execute(ctx, req.GetUserId()); err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &emptypb.Empty{}, nil
}

func (s *Server) ForceShowStarNag(ctx context.Context, req *tenantv1.ForceShowStarNagRequest) (*emptypb.Empty, error) {
	if err := s.forceShowStarNag.Execute(ctx, req.GetUserId()); err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &emptypb.Empty{}, nil
}

func (s *Server) NotifyStarNagOnboardingCompleted(ctx context.Context, req *tenantv1.NotifyStarNagOnboardingCompletedRequest) (*emptypb.Empty, error) {
	if err := s.notifyStarNagOnboardingCompleted.Execute(ctx, req.GetUserId()); err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &emptypb.Empty{}, nil
}

func (s *Server) OpenWebStarNag(ctx context.Context, req *tenantv1.OpenWebStarNagRequest) (*emptypb.Empty, error) {
	if err := s.openWebStarNag.Execute(ctx, req.GetUserId()); err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &emptypb.Empty{}, nil
}

func (s *Server) StarOrcaFromNag(ctx context.Context, req *tenantv1.StarOrcaFromNagRequest) (*tenantv1.StarOrcaFromNagResponse, error) {
	starred, err := s.starOrcaFromNag.Execute(ctx, req.GetUserId())
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &tenantv1.StarOrcaFromNagResponse{Starred: starred}, nil
}

func (s *Server) PrepareStarNagAgentValueMoment(ctx context.Context, req *tenantv1.PrepareStarNagAgentValueMomentRequest) (*tenantv1.StarNagAgentValueMomentPreparation, error) {
	result, err := s.prepareStarNagAgentValueMoment.Execute(ctx, req.GetUserId(), req.GetAppVersion())
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &tenantv1.StarNagAgentValueMomentPreparation{Status: result.Status, Mode: result.Mode}, nil
}

func (s *Server) ShowPreparedStarNagAgentValueMoment(ctx context.Context, req *tenantv1.ShowPreparedStarNagAgentValueMomentRequest) (*emptypb.Empty, error) {
	if err := s.showPreparedStarNagAgentValueMoment.Execute(ctx, req.GetUserId()); err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &emptypb.Empty{}, nil
}

func toProtoUserProfile(p domain.UserProfile) (*tenantv1.UserProfile, error) {
	settingsJSON, err := marshalSettings(p.Settings)
	if err != nil {
		return nil, apperrors.New(apperrors.KindInternal, "TENANT_MARSHAL_PROFILE_FAILED", "failed to marshal user profile settings", err)
	}
	return &tenantv1.UserProfile{
		UserId: p.UserID, CompanyId: p.CompanyID, DepartmentId: p.DepartmentID, SettingsJson: settingsJSON,
	}, nil
}

func toProtoCompany(c domain.Company) (*tenantv1.Company, error) {
	settingsJSON, err := marshalSettings(c.Settings)
	if err != nil {
		return nil, apperrors.New(apperrors.KindInternal, "TENANT_MARSHAL_COMPANY_FAILED", "failed to marshal company settings", err)
	}
	return &tenantv1.Company{Id: c.ID, Name: c.Name, SettingsJson: settingsJSON}, nil
}

func toProtoDepartment(d domain.Department) (*tenantv1.Department, error) {
	settingsJSON, err := marshalSettings(d.Settings)
	if err != nil {
		return nil, apperrors.New(apperrors.KindInternal, "TENANT_MARSHAL_DEPARTMENT_FAILED", "failed to marshal department settings", err)
	}
	return &tenantv1.Department{Id: d.ID, CompanyId: d.CompanyID, Name: d.Name, SettingsJson: settingsJSON}, nil
}

func toProtoTeam(t domain.Team) (*tenantv1.Team, error) {
	settingsJSON, err := marshalSettings(t.Settings)
	if err != nil {
		return nil, apperrors.New(apperrors.KindInternal, "TENANT_MARSHAL_TEAM_FAILED", "failed to marshal team settings", err)
	}
	return &tenantv1.Team{Id: t.ID, CompanyId: t.CompanyID, Name: t.Name, SettingsJson: settingsJSON}, nil
}
