// profile.* / project.* / projectGroup.* / projectHostSetup.* channel
// wiring — see specs/backend-go/bugs/missing-v1/tasks/TASK-126..145.md.
//
// Deliberately kept in its own file, NOT appended to channels.go: this pass
// (tenant-service's profile.* RPCs + project-service's project/member/
// projectGroup/projectHostSetup RPCs) lands in parallel with other groups
// also extending channels.go/RegisterRealChannels/main.go in their own
// worktrees. registerTenantProjectChannels below is self-contained and NOT
// yet called from RegisterRealChannels — the final integration pass wires
// it in with one line (see this file's bottom doc comment) once every
// parallel group's channels_*.go has landed, to avoid clashing edits to the
// same function/file.
package wscompat

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	projectv1 "github.com/stablyai/orca-go/proto/gen/go/orca/project/v1"
	tenantv1 "github.com/stablyai/orca-go/proto/gen/go/orca/tenant/v1"

	gatewaygrpc "github.com/stablyai/orca-go/services/api-gateway/internal/adapter/grpc"
	"github.com/stablyai/orca-go/services/api-gateway/internal/usecase"
)

// errNotAdmin is returned by profile.createCompany/createDept — tenant-service
// itself has no role-based authorization (unlike infra-fleet-service's
// requireAdmin), so this gate lives here, at the gateway edge, the same
// place attachAdminIdentity's admin-gated channels live in
// channels_dev_server_access_control.go. Company/department creation is
// rare, foundational, org-wide state — not something a regular user should
// ever be able to trigger.
var errNotAdmin = errors.New("caller is not an admin")

// rpcTimeout (8s) is already declared package-wide in channels.go — reused
// here as-is per that file's own anticipated-collision note; deduped during
// the integration pass.

// registerTenantProjectChannels wires every profile.*/project.*/
// projectGroup.*/projectHostSetup.* channel this pass gives real backend-go
// implementations to. Call from main.go's composition root (or from
// RegisterRealChannels, once the integration pass merges this in) with the
// already-dialed tenantClient/projectClient — see main.go's existing
// `tenantClient := tenantv1.NewTenantServiceClient(tenantConn)` and
// `projectClient := projectv1.NewProjectServiceClient(projectConn)`.
func registerTenantProjectChannels(r *Registry, tenantClient tenantv1.TenantServiceClient, projectClient projectv1.ProjectServiceClient) {
	registerProfileChannels(r, tenantClient)
	registerProjectChannels(r, projectClient)
	registerProjectGroupChannels(r, projectClient)
	registerProjectHostSetupChannels(r, projectClient)
}

// ── profile.* ──────────────────────────────────────────────────────────
//
// profile.getResolved: RPC + REST already exist (tenant_routes.go's
// handleGetResolvedProfile) — wiring-only. The other 5 profile.* channels
// (getUserProfile/listDepts/updateCompany/updateDept/updateUser) call the
// new RPCs TASK-127/128 added to tenant.proto/tenant-service.

// userProfileView/departmentView: protoc-gen-go's own `encoding/json` struct
// tags are snake_case (e.g. `json:"department_id,omitempty"`), not the
// camelCase a TypeScript frontend expects — the wscompat envelope
// serializes `Result any` via plain encoding/json, not protojson. Found live
// while wiring the Department Gate (CR-DS-008): profile.getUserProfile/
// listDepts/updateUser previously returned the raw *tenantv1.UserProfile/
// Department, silently shipping departmentId/companyId/etc. as undefined to
// the frontend. Same fix pattern as devServerView etc. in
// channels_dev_server_access_control.go.
type userProfileView struct {
	UserID       string `json:"userId"`
	CompanyID    string `json:"companyId"`
	DepartmentID string `json:"departmentId"`
	SettingsJSON string `json:"settingsJson"`
}

type departmentView struct {
	ID           string `json:"id"`
	CompanyID    string `json:"companyId"`
	Name         string `json:"name"`
	SettingsJSON string `json:"settingsJson"`
}

// companyView — same bug, same fix, for profile.updateCompany/createCompany:
// tenantv1.Company.SettingsJson has `json:"settings_json,omitempty"`.
type companyView struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	SettingsJSON string `json:"settingsJson"`
}

func toUserProfileView(p *tenantv1.UserProfile) userProfileView {
	return userProfileView{
		UserID:       p.GetUserId(),
		CompanyID:    p.GetCompanyId(),
		DepartmentID: p.GetDepartmentId(),
		SettingsJSON: p.GetSettingsJson(),
	}
}

func toCompanyView(c *tenantv1.Company) companyView {
	return companyView{ID: c.GetId(), Name: c.GetName(), SettingsJSON: c.GetSettingsJson()}
}

func toDepartmentView(d *tenantv1.Department) departmentView {
	return departmentView{
		ID:           d.GetId(),
		CompanyID:    d.GetCompanyId(),
		Name:         d.GetName(),
		SettingsJSON: d.GetSettingsJson(),
	}
}

func registerProfileChannels(r *Registry, client tenantv1.TenantServiceClient) {
	r.Register("profile.getResolved", func(ctx context.Context, id Identity, _ []json.RawMessage) (any, error) {
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		resp, err := client.GetResolvedProfile(rpcCtx, &tenantv1.GetResolvedProfileRequest{UserId: id.UserID})
		if err != nil {
			return nil, err
		}
		return resp, nil
	})

	r.Register("profile.getUserProfile", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type getArgs struct {
			UserID string `json:"userId"`
		}
		// decodeOptionalArg, not decodeArg: userId is genuinely optional —
		// "no userId → resolves from session" is this method's documented
		// contract (specs/frontend/api/rpc-catalog.md).
		in := decodeOptionalArg[getArgs](args, 0)
		userID := cmp.Or(in.UserID, id.UserID)
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		// Why (found live, specs/backend-go/bugs/missing-v2/ follow-up):
		// this previously always sent in.UserID verbatim — an omitted userId
		// decoded to "", which tenant-service's GetUserProfile binds
		// straight into a UUID column, erroring TENANT_PROFILE_LOOKUP_FAILED
		// instead of resolving the caller's own profile. Defaulting to
		// id.UserID matches profile.getResolved's pattern immediately above.
		resp, err := client.GetUserProfile(rpcCtx, &tenantv1.GetUserProfileRequest{UserId: userID})
		if err != nil {
			return nil, err
		}
		return toUserProfileView(resp.GetProfile()), nil
	})

	r.Register("profile.listDepts", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type listArgs struct {
			CompanyID string `json:"companyId"`
		}
		// decodeOptionalArg — companyId is optional, defaults to the
		// caller's own tenant (a Company row's id IS the tenant_id in this
		// domain — tenant-service.md).
		in := decodeOptionalArg[listArgs](args, 0)
		companyID := cmp.Or(in.CompanyID, id.TenantID)
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		// Why: same class of bug as profile.getUserProfile above — an
		// omitted companyId previously decoded to "", bound straight into a
		// UUID column by tenant-service's ListDepartments, erroring
		// TENANT_LIST_DEPARTMENTS_FAILED instead of listing the caller's
		// own company's departments.
		resp, err := client.ListDepartments(rpcCtx, &tenantv1.ListDepartmentsRequest{CompanyId: companyID})
		if err != nil {
			return nil, err
		}
		// []departmentView, not resp.GetDepartments(): keeps the established
		// "empty list channels return [] not null" convention too, since a
		// nil proto slice converts to a non-nil empty slice here.
		views := make([]departmentView, 0, len(resp.GetDepartments()))
		for _, d := range resp.GetDepartments() {
			views = append(views, toDepartmentView(d))
		}
		return views, nil
	})

	r.Register("profile.getCompany", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type getArgs struct {
			ID string `json:"id"`
		}
		// decodeOptionalArg — id is optional, defaults to the caller's own
		// company, same "a Company row's id IS the tenant_id in this
		// domain" convention profile.listDepts already documents.
		in := decodeOptionalArg[getArgs](args, 0)
		companyID := cmp.Or(in.ID, id.TenantID)
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		resp, err := client.GetCompany(rpcCtx, &tenantv1.GetCompanyRequest{Id: companyID})
		if err != nil {
			return nil, err
		}
		return toCompanyView(resp.GetCompany()), nil
	})

	// profile.listCompanies — admin-only, cross-tenant (see
	// usecase.CompanyRepository.List's doc comment on tenant-service).
	// Without this, a company created via profile.createCompany was
	// unreachable the instant the creating session ended: nothing else ever
	// listed tenant.companies, so the Admin Console's "New company" flow
	// silently dropped it after the creation toast disappeared.
	r.Register("profile.listCompanies", func(ctx context.Context, id Identity, _ []json.RawMessage) (any, error) {
		if id.Role != "admin" {
			return nil, errNotAdmin
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID, Role: id.Role})
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		resp, err := client.ListCompanies(rpcCtx, &tenantv1.ListCompaniesRequest{})
		if err != nil {
			return nil, err
		}
		views := make([]companyView, 0, len(resp.GetCompanies()))
		for _, c := range resp.GetCompanies() {
			views = append(views, toCompanyView(c))
		}
		return map[string]any{"companies": views}, nil
	})

	r.Register("profile.updateCompany", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type updateArgs struct {
			ID           string `json:"id"`
			Name         string `json:"name"`
			SettingsJSON string `json:"settingsJson"`
		}
		in, err := decodeArg[updateArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		resp, err := client.UpdateCompany(rpcCtx, &tenantv1.UpdateCompanyRequest{
			Id: in.ID, Name: in.Name, SettingsJson: in.SettingsJSON,
		})
		if err != nil {
			return nil, err
		}
		return toCompanyView(resp.GetCompany()), nil
	})

	r.Register("profile.createCompany", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		if id.Role != "admin" {
			return nil, errNotAdmin
		}
		type createArgs struct {
			Name string `json:"name"`
		}
		in, err := decodeArg[createArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID, Role: id.Role})
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		resp, err := client.CreateCompany(rpcCtx, &tenantv1.CreateCompanyRequest{Name: in.Name})
		if err != nil {
			return nil, err
		}
		return toCompanyView(resp.GetCompany()), nil
	})

	r.Register("profile.createDept", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		if id.Role != "admin" {
			return nil, errNotAdmin
		}
		type createArgs struct {
			CompanyID string `json:"companyId"`
			Name      string `json:"name"`
		}
		in, err := decodeArg[createArgs](args, 0)
		if err != nil {
			return nil, err
		}
		// Why default to id.TenantID: same "a Company row's id IS the
		// tenant_id in this domain" convention profile.listDepts already
		// documents — the caller's own company, unless they explicitly name
		// a different one.
		companyID := cmp.Or(in.CompanyID, id.TenantID)
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID, Role: id.Role})
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		resp, err := client.CreateDepartment(rpcCtx, &tenantv1.CreateDepartmentRequest{CompanyId: companyID, Name: in.Name})
		if err != nil {
			return nil, err
		}
		return toDepartmentView(resp.GetDepartment()), nil
	})

	r.Register("profile.updateDept", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type updateArgs struct {
			ID           string `json:"id"`
			Name         string `json:"name"`
			SettingsJSON string `json:"settingsJson"`
		}
		in, err := decodeArg[updateArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		resp, err := client.UpdateDepartment(rpcCtx, &tenantv1.UpdateDepartmentRequest{
			Id: in.ID, Name: in.Name, SettingsJson: in.SettingsJSON,
		})
		if err != nil {
			return nil, err
		}
		return toDepartmentView(resp.GetDepartment()), nil
	})

	r.Register("profile.updateUser", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type updateArgs struct {
			UserID          string `json:"userId"`
			DepartmentID    string `json:"departmentId"`
			ClearDepartment bool   `json:"clearDepartment"`
			SettingsJSON    string `json:"settingsJson"`
		}
		// decodeOptionalArg, not decodeArg: userId is optional, same
		// "omitted → resolves from session" contract as profile.getUserProfile
		// above (the Department Gate calls this to set the CALLER's own
		// department without needing to already know their own user id).
		in := decodeOptionalArg[updateArgs](args, 0)
		userID := cmp.Or(in.UserID, id.UserID)
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		resp, err := client.UpdateUserProfile(rpcCtx, &tenantv1.UpdateUserProfileRequest{
			UserId: userID, DepartmentId: in.DepartmentID, ClearDepartment: in.ClearDepartment, SettingsJson: in.SettingsJSON,
		})
		if err != nil {
			return nil, err
		}
		return toUserProfileView(resp.GetProfile()), nil
	})
}

// projectView/toProjectView, projectMemberView/toProjectMemberView,
// projectGroupView/toProjectGroupView, hostSetupView/toHostSetupView,
// nestedRepoCandidateView/toNestedRepoCandidateView: protoc-gen-go's own
// encoding/json struct tags are snake_case (e.g. `json:"dev_server_id"`,
// `json:"parent_group_id"`), and ProjectRole is a proto enum that plain
// encoding/json marshals as a bare int — but this envelope's Result field
// (envelope.go) is serialized via plain encoding/json (wsjson.Write), not
// protojson. Returning a raw proto struct/enum here silently ships
// undefined/wrong-typed fields to a frontend that only ever reads
// camelCase strings (types/workspace-types.ts's OrcaProject/ProjectMember).
// Same bug class already fixed for profile.* above (userProfileView/
// departmentView/companyView) — found live for the rest of this file
// during Phase 4b's repo-catalog unification pass: ProjectSwitcher's
// devServerId, MemberManager's role/userId, projectGroup.update's
// parentGroupId, etc. were all silently broken on the wire.
type projectView struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	Description   string `json:"description"`
	DevServerID   string `json:"devServerId"`
	DefaultBranch string `json:"defaultBranch"`
	Visibility    string `json:"visibility"`
	CreatedBy     string `json:"createdBy"`
	CreatedAt     int64  `json:"createdAt"`
	UpdatedAt     int64  `json:"updatedAt"`
	// MobileEmulatorAgentID — CR-DS-009 §3.2, the parallel independent
	// binding to DevServerID (which infra-fleet-service DevServer with
	// kind=AGENT_KIND_MOBILE_EMULATOR this project's Mobile Emulator pane
	// routes emulator.* control to). Empty = not bound yet.
	MobileEmulatorAgentID string `json:"mobileEmulatorAgentId"`
}

func toProjectView(p *projectv1.Project) projectView {
	return projectView{
		ID: p.GetId(), Name: p.GetName(), Description: p.GetDescription(),
		DevServerID: p.GetDevServerId(), DefaultBranch: p.GetDefaultBranch(),
		Visibility: p.GetVisibility(), CreatedBy: p.GetCreatedBy(),
		CreatedAt: protoTimeMillis(p.GetCreatedAt()), UpdatedAt: protoTimeMillis(p.GetUpdatedAt()),
		MobileEmulatorAgentID: p.GetMobileEmulatorAgentId(),
	}
}

type projectMemberView struct {
	UserID string `json:"userId"`
	Role   string `json:"role"`
}

func toProjectMemberView(m *projectv1.Member) projectMemberView {
	return projectMemberView{UserID: m.GetUserId(), Role: fromProjectRoleArg(m.GetRole())}
}

type projectGroupView struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	ParentGroupID string `json:"parentGroupId"`
	ProjectID     string `json:"projectId"`
}

func toProjectGroupView(g *projectv1.ProjectGroup) projectGroupView {
	return projectGroupView{
		ID: g.GetId(), Name: g.GetName(),
		ParentGroupID: g.GetParentGroupId(), ProjectID: g.GetProjectId(),
	}
}

type hostSetupView struct {
	ID          string `json:"id"`
	DevServerID string `json:"devServerId"`
	FolderPath  string `json:"folderPath"`
	DisplayName string `json:"displayName"`
	Status      string `json:"status"`
	ProjectID   string `json:"projectId"`
}

func toHostSetupView(s *projectv1.HostSetup) hostSetupView {
	return hostSetupView{
		ID: s.GetId(), DevServerID: s.GetDevServerId(), FolderPath: s.GetFolderPath(),
		DisplayName: s.GetDisplayName(), Status: s.GetStatus(), ProjectID: s.GetProjectId(),
	}
}

type nestedRepoCandidateView struct {
	Path          string `json:"path"`
	SuggestedName string `json:"suggestedName"`
	IsGitRepo     bool   `json:"isGitRepo"`
}

func toNestedRepoCandidateView(c *projectv1.NestedRepoCandidate) nestedRepoCandidateView {
	return nestedRepoCandidateView{Path: c.GetPath(), SuggestedName: c.GetSuggestedName(), IsGitRepo: c.GetIsGitRepo()}
}

// ── project.* ──────────────────────────────────────────────────────────
//
// create/get/list/update: RPC + REST already exist, wiring-only.
// getMembers/removeMember/updateMemberRole call the new RPCs TASK-132/133
// added to project.proto/project-service.
func registerProjectChannels(r *Registry, client projectv1.ProjectServiceClient) {
	r.Register("project.create", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type createArgs struct {
			Name          string `json:"name"`
			Description   string `json:"description"`
			DevServerID   string `json:"devServerId"`
			DefaultBranch string `json:"defaultBranch"`
			Visibility    string `json:"visibility"`
		}
		in, err := decodeArg[createArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		resp, err := client.CreateProject(rpcCtx, &projectv1.CreateProjectRequest{
			TenantId: id.TenantID, Name: in.Name, Description: in.Description,
			DefaultBranch: in.DefaultBranch, Visibility: in.Visibility,
		})
		if err != nil {
			return nil, err
		}
		// Why: CreateProject.Execute's own doc comment says the creator
		// "becomes an implicit owner via a follow-up AddMember call by the
		// caller (api-gateway)" — that follow-up call never actually existed
		// anywhere (checked project-service's gRPC server too), so every
		// created project had zero membership rows. requireProjectAccess
		// grants nothing from Project.CreatedBy alone — only a real
		// project_members row — so the creator's very next call
		// (GetProject, to load the project they just made) was denied
		// PROJECT_NOT_AUTHORIZED. Live-reproduced via "New Project" submit
		// in Project Workspace (Beta).
		if _, err := client.AddMember(rpcCtx, &projectv1.AddMemberRequest{
			ProjectId: resp.GetProject().GetId(), UserId: id.UserID, Role: projectv1.ProjectRole_PROJECT_ROLE_OWNER,
		}); err != nil {
			return nil, fmt.Errorf("project.create: creator membership: %w", err)
		}
		return toProjectView(resp.GetProject()), nil
	})

	r.Register("project.get", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type getArgs struct {
			// Why: json tag must be "projectId" — the ONLY real caller
			// (WorkspaceContext.tsx's switchProject) sends {projectId: ...},
			// never {id: ...}. The previous "id" tag silently decoded to "",
			// which reached project-service's GetMembership as an empty
			// string bound against a uuid-typed column — Postgres rejects
			// that at bind time, wrapped into PROJECT_MEMBERSHIP_LOOKUP_FAILED
			// (live-reproduced: "New Project" submit → immediate GetProject
			// with the just-created id → this error every time).
			ID string `json:"projectId"`
		}
		in, err := decodeArg[getArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		resp, err := client.GetProject(rpcCtx, &projectv1.GetProjectRequest{Id: in.ID})
		if err != nil {
			return nil, err
		}
		return toProjectView(resp.GetProject()), nil
	})

	r.Register("project.list", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type listArgs struct {
			PageToken string `json:"pageToken"`
			PageSize  int32  `json:"pageSize"`
		}
		// list's args are optional (frontend often calls with no args) —
		// decode best-effort, defaulting to zero values on missing/absent arg[0].
		var in listArgs
		if len(args) > 0 {
			in, _ = decodeArg[listArgs](args, 0)
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		// TenantId is always taken from the resolved Identity, never a
		// caller-supplied arg.
		resp, err := client.ListProjects(rpcCtx, &projectv1.ListProjectsRequest{
			TenantId: id.TenantID, PageToken: in.PageToken, PageSize: in.PageSize,
		})
		if err != nil {
			return nil, err
		}
		projects := resp.GetProjects()
		views := make([]projectView, 0, len(projects))
		for _, p := range projects {
			views = append(views, toProjectView(p))
		}
		return views, nil
	})

	r.Register("project.update", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type updateArgs struct {
			ID                    string `json:"id"`
			Name                  string `json:"name"`
			Description           string `json:"description"`
			DefaultBranch         string `json:"defaultBranch"`
			Visibility            string `json:"visibility"`
			MobileEmulatorAgentID string `json:"mobileEmulatorAgentId"`
		}
		in, err := decodeArg[updateArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		resp, err := client.UpdateProject(rpcCtx, &projectv1.UpdateProjectRequest{
			ProjectId: in.ID, Name: in.Name, Description: in.Description,
			DefaultBranch: in.DefaultBranch, Visibility: in.Visibility,
			MobileEmulatorAgentId: in.MobileEmulatorAgentID,
		})
		if err != nil {
			return nil, err
		}
		return toProjectView(resp.GetProject()), nil
	})

	r.Register("project.getMembers", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type getArgs struct {
			ProjectID string `json:"projectId"`
		}
		in, err := decodeArg[getArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		resp, err := client.ListMembers(rpcCtx, &projectv1.ListMembersRequest{ProjectId: in.ProjectID})
		if err != nil {
			return nil, err
		}
		members := resp.GetMembers()
		views := make([]projectMemberView, 0, len(members))
		for _, m := range members {
			views = append(views, toProjectMemberView(m))
		}
		return views, nil
	})

	r.Register("project.removeMember", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type removeArgs struct {
			ProjectID string `json:"projectId"`
			UserID    string `json:"userId"`
		}
		in, err := decodeArg[removeArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		if _, err := client.RemoveMember(rpcCtx, &projectv1.RemoveMemberRequest{
			ProjectId: in.ProjectID, UserId: in.UserID,
		}); err != nil {
			return nil, err
		}
		return map[string]bool{"ok": true}, nil
	})

	r.Register("project.updateMemberRole", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type updateArgs struct {
			ProjectID string `json:"projectId"`
			UserID    string `json:"userId"`
			Role      string `json:"role"`
		}
		in, err := decodeArg[updateArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		resp, err := client.UpdateMemberRole(rpcCtx, &projectv1.UpdateMemberRoleRequest{
			ProjectId: in.ProjectID, UserId: in.UserID, Role: toProjectRoleArg(in.Role),
		})
		if err != nil {
			return nil, err
		}
		return toProjectMemberView(resp.GetMember()), nil
	})

	// Why this channel was missing: AddMember.Execute/proto/REST all existed
	// (project_routes.go's handleAddMember), but no wscompat caller ever
	// reached it except project.create's own internal owner-bootstrap call —
	// MemberManager.tsx could list/remove/re-role members but had no way to
	// add a new one at all.
	r.Register("project.addMember", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type addArgs struct {
			ProjectID string `json:"projectId"`
			UserID    string `json:"userId"`
			Role      string `json:"role"`
		}
		in, err := decodeArg[addArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		// AddMemberResponse carries no payload (unlike UpdateMemberRoleResponse's
		// Member) — echo back what the caller just granted.
		if _, err := client.AddMember(rpcCtx, &projectv1.AddMemberRequest{
			ProjectId: in.ProjectID, UserId: in.UserID, Role: toProjectRoleArg(in.Role),
		}); err != nil {
			return nil, err
		}
		return projectMemberView{UserID: in.UserID, Role: fromProjectRoleArg(toProjectRoleArg(in.Role))}, nil
	})

	// Why this channel was missing: RebindDevServer's usecase (with its
	// workflow/task active-execution guard) and proto RPC existed, but no
	// caller could ever reach it — CreateProjectDialog.tsx collects a dev
	// server but project.create's request has no dev_server_id field at all
	// (bound only via this RPC), so the chosen dev server was silently
	// dropped on every "New Project" submit.
	r.Register("project.rebindDevServer", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type rebindArgs struct {
			ProjectID      string `json:"projectId"`
			NewDevServerID string `json:"newDevServerId"`
		}
		in, err := decodeArg[rebindArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		resp, err := client.RebindDevServer(rpcCtx, &projectv1.RebindDevServerRequest{
			ProjectId: in.ProjectID, NewDevServerId: in.NewDevServerID,
		})
		if err != nil {
			return nil, err
		}
		return toProjectView(resp.GetProject()), nil
	})

	// Why this channel was missing: DeleteProject's usecase (owner/global-admin
	// only, with the same workflow/task active-execution guard as
	// RebindDevServer) and proto RPC existed, but no wscompat caller could ever
	// reach it — same "usecase built, channel never registered" gap as
	// project.rebindDevServer above. ProjectSettings.tsx's General tab had no
	// way to delete a project at all.
	r.Register("project.delete", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type deleteArgs struct {
			ProjectID string `json:"projectId"`
		}
		in, err := decodeArg[deleteArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		if _, err := client.DeleteProject(rpcCtx, &projectv1.DeleteProjectRequest{
			ProjectId: in.ProjectID,
		}); err != nil {
			return nil, err
		}
		return map[string]bool{"ok": true}, nil
	})
}

// toProjectRoleArg maps the wscompat wire arg's role string ("member" |
// "owner") onto projectv1.ProjectRole — mirrors toConnectionMode's shape
// for the same kind of string-to-enum wire mapping.
func toProjectRoleArg(role string) projectv1.ProjectRole {
	switch role {
	case "owner":
		return projectv1.ProjectRole_PROJECT_ROLE_OWNER
	case "member":
		return projectv1.ProjectRole_PROJECT_ROLE_MEMBER
	default:
		return projectv1.ProjectRole_PROJECT_ROLE_UNSPECIFIED
	}
}

// fromProjectRoleArg is toProjectRoleArg's inverse — every project.*Member*
// response view needs it: ProjectRole is a proto enum, which plain
// encoding/json marshals as a bare int (0/1/2), not the "owner"/"member"
// string types/workspace-types.ts's ProjectMember expects.
func fromProjectRoleArg(role projectv1.ProjectRole) string {
	switch role {
	case projectv1.ProjectRole_PROJECT_ROLE_OWNER:
		return "owner"
	case projectv1.ProjectRole_PROJECT_ROLE_MEMBER:
		return "member"
	default:
		return ""
	}
}

// ── projectGroup.* ─────────────────────────────────────────────────────
//
// create/update/delete/list: RPC + REST already exist, wiring-only.
// moveProject/scanNested/importNested call the new RPCs TASK-137/138 added
// to project.proto/project-service.
func registerProjectGroupChannels(r *Registry, client projectv1.ProjectServiceClient) {
	r.Register("projectGroup.create", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type createArgs struct {
			Name          string `json:"name"`
			ParentGroupID string `json:"parentGroupId"`
		}
		in, err := decodeArg[createArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		resp, err := client.CreateProjectGroup(rpcCtx, &projectv1.CreateProjectGroupRequest{
			Name: in.Name, ParentGroupId: in.ParentGroupID,
		})
		if err != nil {
			return nil, err
		}
		return toProjectGroupView(resp.GetGroup()), nil
	})

	r.Register("projectGroup.update", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type updateArgs struct {
			GroupID string `json:"groupId"`
			Name    string `json:"name"`
		}
		in, err := decodeArg[updateArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		resp, err := client.UpdateProjectGroup(rpcCtx, &projectv1.UpdateProjectGroupRequest{
			GroupId: in.GroupID, Name: in.Name,
		})
		if err != nil {
			return nil, err
		}
		return toProjectGroupView(resp.GetGroup()), nil
	})

	r.Register("projectGroup.delete", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type deleteArgs struct {
			GroupID string `json:"groupId"`
		}
		in, err := decodeArg[deleteArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		if _, err := client.DeleteProjectGroup(rpcCtx, &projectv1.DeleteProjectGroupRequest{GroupId: in.GroupID}); err != nil {
			return nil, err
		}
		return map[string]bool{"ok": true}, nil
	})

	r.Register("projectGroup.list", func(ctx context.Context, id Identity, _ []json.RawMessage) (any, error) {
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		resp, err := client.ListProjectGroups(rpcCtx, &projectv1.ListProjectGroupsRequest{})
		if err != nil {
			return nil, err
		}
		groups := resp.GetGroups()
		views := make([]projectGroupView, 0, len(groups))
		for _, g := range groups {
			views = append(views, toProjectGroupView(g))
		}
		return views, nil
	})

	r.Register("projectGroup.moveProject", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type moveArgs struct {
			ProjectID           string `json:"projectId"`
			TargetParentGroupID string `json:"targetParentGroupId"`
		}
		in, err := decodeArg[moveArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		resp, err := client.MoveProject(rpcCtx, &projectv1.MoveProjectRequest{
			ProjectId: in.ProjectID, TargetParentGroupId: in.TargetParentGroupID,
		})
		if err != nil {
			return nil, err
		}
		return toProjectGroupView(resp.GetGroup()), nil
	})

	r.Register("projectGroup.scanNested", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type scanArgs struct {
			DevServerID string `json:"devServerId"`
			RootPath    string `json:"rootPath"`
		}
		in, err := decodeArg[scanArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		// Longer, explicit deadline: a filesystem scan over a possibly-deep
		// tree on a remote host can legitimately exceed rpcTimeout — see
		// infra-fleet-service.md §8's "Deadlines" note for Agent-bound calls.
		rpcCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		resp, err := client.ScanNested(rpcCtx, &projectv1.ScanNestedRequest{
			DevServerId: in.DevServerID, RootPath: in.RootPath,
		})
		if err != nil {
			return nil, err
		}
		candidates := resp.GetCandidates()
		views := make([]nestedRepoCandidateView, 0, len(candidates))
		for _, c := range candidates {
			views = append(views, toNestedRepoCandidateView(c))
		}
		return views, nil
	})

	r.Register("projectGroup.importNested", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type candidateArg struct {
			Path          string `json:"path"`
			SuggestedName string `json:"suggestedName"`
			IsGitRepo     bool   `json:"isGitRepo"`
		}
		type importArgs struct {
			DevServerID   string         `json:"devServerId"`
			ParentGroupID string         `json:"parentGroupId"`
			Selected      []candidateArg `json:"selected"`
		}
		in, err := decodeArg[importArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		selected := make([]*projectv1.NestedRepoCandidate, 0, len(in.Selected))
		for _, c := range in.Selected {
			selected = append(selected, &projectv1.NestedRepoCandidate{
				Path: c.Path, SuggestedName: c.SuggestedName, IsGitRepo: c.IsGitRepo,
			})
		}
		resp, err := client.ImportNested(rpcCtx, &projectv1.ImportNestedRequest{
			DevServerId: in.DevServerID, ParentGroupId: in.ParentGroupID, Selected: selected,
		})
		if err != nil {
			return nil, err
		}
		// Why a view struct, not raw resp: ImportNestedResponse's
		// created_groups/created_projects are the same camelCase bug as
		// every other view in this file, one level deeper (nested proto
		// messages inside a proto message).
		createdGroups := resp.GetCreatedGroups()
		groupViews := make([]projectGroupView, 0, len(createdGroups))
		for _, g := range createdGroups {
			groupViews = append(groupViews, toProjectGroupView(g))
		}
		createdProjects := resp.GetCreatedProjects()
		projectViews := make([]projectView, 0, len(createdProjects))
		for _, p := range createdProjects {
			projectViews = append(projectViews, toProjectView(p))
		}
		return map[string]any{
			"createdGroups":   groupViews,
			"createdProjects": projectViews,
		}, nil
	})
}

// ── projectHostSetup.* ─────────────────────────────────────────────────
//
// All 5 channels call brand-new RPCs (TASK-141/143 added to
// project.proto/project-service) — none of these are wiring-only.
func registerProjectHostSetupChannels(r *Registry, client projectv1.ProjectServiceClient) {
	r.Register("projectHostSetup.create", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type createArgs struct {
			DevServerID string `json:"devServerId"`
			FolderPath  string `json:"folderPath"`
			DisplayName string `json:"displayName"`
		}
		in, err := decodeArg[createArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		resp, err := client.CreateHostSetup(rpcCtx, &projectv1.CreateHostSetupRequest{
			DevServerId: in.DevServerID, FolderPath: in.FolderPath, DisplayName: in.DisplayName,
		})
		if err != nil {
			return nil, err
		}
		return toHostSetupView(resp.GetSetup()), nil
	})

	r.Register("projectHostSetup.list", func(ctx context.Context, id Identity, _ []json.RawMessage) (any, error) {
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		resp, err := client.ListHostSetups(rpcCtx, &projectv1.ListHostSetupsRequest{})
		if err != nil {
			return nil, err
		}
		setups := resp.GetSetups()
		views := make([]hostSetupView, 0, len(setups))
		for _, s := range setups {
			views = append(views, toHostSetupView(s))
		}
		return views, nil
	})

	r.Register("projectHostSetup.update", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type updateArgs struct {
			ID          string `json:"id"`
			FolderPath  string `json:"folderPath"`
			DisplayName string `json:"displayName"`
		}
		in, err := decodeArg[updateArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		resp, err := client.UpdateHostSetup(rpcCtx, &projectv1.UpdateHostSetupRequest{
			Id: in.ID, FolderPath: in.FolderPath, DisplayName: in.DisplayName,
		})
		if err != nil {
			return nil, err
		}
		return toHostSetupView(resp.GetSetup()), nil
	})

	r.Register("projectHostSetup.delete", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type deleteArgs struct {
			ID string `json:"id"`
		}
		in, err := decodeArg[deleteArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		if _, err := client.DeleteHostSetup(rpcCtx, &projectv1.DeleteHostSetupRequest{Id: in.ID}); err != nil {
			return nil, err
		}
		return map[string]bool{"ok": true}, nil
	})

	r.Register("projectHostSetup.setupExistingFolder", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type setupArgs struct {
			ID string `json:"id"`
		}
		in, err := decodeArg[setupArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		// Same reasoning as projectGroup.scanNested — a remote
		// path-check-then-finalize round-trip can exceed rpcTimeout.
		rpcCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		resp, err := client.SetupExistingFolder(rpcCtx, &projectv1.SetupExistingFolderRequest{Id: in.ID})
		if err != nil {
			return nil, err
		}
		// project stays nil (not a zero-value view) on failure — Project is
		// only set on success per SetupExistingFolderResponse's own doc
		// comment, and the handler does no status branching itself
		// (TASK-143 Step 9), so a raw passthrough of that nil-ness matters.
		var project any
		if resp.GetProject() != nil {
			project = toProjectView(resp.GetProject())
		}
		return map[string]any{
			"setup":   toHostSetupView(resp.GetSetup()),
			"project": project,
		}, nil
	})
}

// Integration-pass wiring (NOT yet applied — see this file's top doc
// comment):
//
//  1. channels.go: add `tenantClient tenantv1.TenantServiceClient` and
//     `projectClient projectv1.ProjectServiceClient` params to
//     RegisterRealChannels, and call
//     `registerTenantProjectChannels(r, tenantClient, projectClient)`
//     from its body.
//  2. main.go: change the RegisterRealChannels call site to
//     `wscompat.RegisterRealChannels(wsCompatRegistry, annotationClient, taskClient, gitClient, automationClient, infraFleetClient, tenantClient, projectClient, rateLimiter)`
//     (tenantClient/projectClient are already dialed in main.go for
//     mountTenantRoutes/mountProjectRoutes — no new Dial call needed;
//     merge param order with whatever other parallel groups' channels_*.go
//     additions already appended to RegisterRealChannels's signature).
