// Package grpc implements the generated infrafleetv1.InfraFleetServiceServer
// interface by translating wire messages to/from usecase calls — no
// business logic here, per
// specs/backend-go/architecture/03-clean-architecture-guidelines.md's
// inbound-adapter contract.
package grpc

import (
	"context"
	"encoding/json"
	"time"

	"google.golang.org/grpc/metadata"
	"google.golang.org/protobuf/types/known/emptypb"
	"google.golang.org/protobuf/types/known/timestamppb"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/common/grpcmw"
	"github.com/stablyai/orca-go/common/tenant"
	"github.com/stablyai/orca-go/services/infra-fleet-service/internal/domain"
	"github.com/stablyai/orca-go/services/infra-fleet-service/internal/usecase"

	infrafleetv1 "github.com/stablyai/orca-go/proto/gen/go/orca/infrafleet/v1"
)

// Server implements infrafleetv1.UnimplementedInfraFleetServiceServer.
type Server struct {
	infrafleetv1.UnimplementedInfraFleetServiceServer

	registerDevServer  *usecase.RegisterDevServer
	resolveConnection  *usecase.ResolveConnection
	createSshTarget    *usecase.CreateSshTarget
	getFleetHealth     *usecase.GetFleetHealth
	scanWorkspacePorts *usecase.ScanWorkspacePorts
	listDevServers     *usecase.ListDevServers
	createConnection   *usecase.CreateConnection
	relay              *usecase.Relay

	listSshTargets      *usecase.ListSshTargets
	getSshState         *usecase.GetSshState
	establishConnection *usecase.EstablishConnection
	killWorkspacePort   *usecase.KillWorkspacePort
	// teardownConnection backs the confirmed-logout explicit-close RPC
	// (BE-SOL-STORAGE-003 §5, TASK-BE-STORAGE-012).
	teardownConnection *usecase.TeardownConnection
	// --- Terminal/PTY (TASK-185) ---
	spawnTerminalSession   *usecase.SpawnTerminalSession
	resizeTerminalSession  *usecase.ResizeTerminalSession
	killTerminalSession    *usecase.KillTerminalSession
	stopTerminalProcess    *usecase.StopTerminalProcess
	listTerminalSessions   *usecase.ListTerminalSessions
	waitTerminalSession    *usecase.WaitTerminalSession
	focusTerminalSession   *usecase.FocusTerminalSession
	getTerminalAgentStatus *usecase.GetTerminalAgentStatus
	inspectTerminalProcess *usecase.InspectTerminalProcess
	attachPty              *usecase.AttachPty
	attachScreencast       *usecase.AttachScreencast
	listBrowserProfiles    *usecase.ListBrowserProfiles
	createBrowserProfile   *usecase.CreateBrowserProfile
	deleteBrowserProfile   *usecase.DeleteBrowserProfile

	// --- Emulator relay (TASK-048) / host capabilities relay (TASK-070) ---
	// Shipped-but-honestly-inert until agent/ gains device.*/host.capabilities
	// — see usecase.EmulatorRelay / usecase.GetHostCapabilities doc comments.
	emulatorRelay       *usecase.EmulatorRelay
	getHostCapabilities *usecase.GetHostCapabilities

	// --- CR-DS-006 Phase 2 / CR-DS-007 / CR-DS-008 (dev server access control) ---
	approveDevServer           *usecase.ApproveDevServer
	rejectDevServer            *usecase.RejectDevServer
	assignDevServerGroup       *usecase.AssignDevServerGroup
	createDevServerGroup       *usecase.CreateDevServerGroup
	listDevServerGroups        *usecase.ListDevServerGroups
	grantDevServerGroupAccess  *usecase.GrantDevServerGroupAccess
	revokeDevServerGroupAccess *usecase.RevokeDevServerGroupAccess
	listDevServerGroupGrants   *usecase.ListDevServerGroupGrants
	listDevServersForUser      *usecase.ListDevServersForUser
	createAccessRequest        *usecase.CreateAccessRequest
	listPendingAccessRequests  *usecase.ListPendingAccessRequests
	resolveAccessRequest       *usecase.ResolveAccessRequest

	relayByDevServer     *usecase.RelayByDevServer
	isDevServerConnected *usecase.IsDevServerConnected

	// --- Ephemeral VM (SOL-004 Group 1/2a, TASK-002/004) ---
	listEphemeralVmRuntimes *usecase.ListEphemeralVmRuntimes
	ephemeralVmRelay        *usecase.EphemeralVmRelay

	// getFleetConnectivitySummary backs CR-STORAGE-007's poll-driven health
	// summary (TASK-BE-STORAGE-006) — see usecase.GetFleetConnectivitySummary's
	// doc comment.
	getFleetConnectivitySummary *usecase.GetFleetConnectivitySummary

	// streamFileChanges backs BACKLOG-003's file-watch streaming RPC.
	streamFileChanges *usecase.StreamFileChanges
}

func New(
	registerDevServer *usecase.RegisterDevServer,
	resolveConnection *usecase.ResolveConnection,
	createSshTarget *usecase.CreateSshTarget,
	getFleetHealth *usecase.GetFleetHealth,
	scanWorkspacePorts *usecase.ScanWorkspacePorts,
	listDevServers *usecase.ListDevServers,
	createConnection *usecase.CreateConnection,
	relay *usecase.Relay,
	listSshTargets *usecase.ListSshTargets,
	getSshState *usecase.GetSshState,
	establishConnection *usecase.EstablishConnection,
	killWorkspacePort *usecase.KillWorkspacePort,
	spawnTerminalSession *usecase.SpawnTerminalSession,
	resizeTerminalSession *usecase.ResizeTerminalSession,
	killTerminalSession *usecase.KillTerminalSession,
	stopTerminalProcess *usecase.StopTerminalProcess,
	listTerminalSessions *usecase.ListTerminalSessions,
	waitTerminalSession *usecase.WaitTerminalSession,
	focusTerminalSession *usecase.FocusTerminalSession,
	getTerminalAgentStatus *usecase.GetTerminalAgentStatus,
	inspectTerminalProcess *usecase.InspectTerminalProcess,
	attachPty *usecase.AttachPty,
	attachScreencast *usecase.AttachScreencast,
	listBrowserProfiles *usecase.ListBrowserProfiles,
	createBrowserProfile *usecase.CreateBrowserProfile,
	deleteBrowserProfile *usecase.DeleteBrowserProfile,
	emulatorRelay *usecase.EmulatorRelay,
	getHostCapabilities *usecase.GetHostCapabilities,
	approveDevServer *usecase.ApproveDevServer,
	rejectDevServer *usecase.RejectDevServer,
	assignDevServerGroup *usecase.AssignDevServerGroup,
	createDevServerGroup *usecase.CreateDevServerGroup,
	listDevServerGroups *usecase.ListDevServerGroups,
	grantDevServerGroupAccess *usecase.GrantDevServerGroupAccess,
	revokeDevServerGroupAccess *usecase.RevokeDevServerGroupAccess,
	listDevServerGroupGrants *usecase.ListDevServerGroupGrants,
	listDevServersForUser *usecase.ListDevServersForUser,
	createAccessRequest *usecase.CreateAccessRequest,
	listPendingAccessRequests *usecase.ListPendingAccessRequests,
	resolveAccessRequest *usecase.ResolveAccessRequest,
	relayByDevServer *usecase.RelayByDevServer,
	isDevServerConnected *usecase.IsDevServerConnected,
	listEphemeralVmRuntimes *usecase.ListEphemeralVmRuntimes,
	ephemeralVmRelay *usecase.EphemeralVmRelay,
	getFleetConnectivitySummary *usecase.GetFleetConnectivitySummary,
	teardownConnection *usecase.TeardownConnection,
	streamFileChanges *usecase.StreamFileChanges,
) *Server {
	return &Server{
		registerDevServer:          registerDevServer,
		resolveConnection:          resolveConnection,
		createSshTarget:            createSshTarget,
		getFleetHealth:             getFleetHealth,
		scanWorkspacePorts:         scanWorkspacePorts,
		listDevServers:             listDevServers,
		createConnection:           createConnection,
		relay:                      relay,
		listSshTargets:             listSshTargets,
		getSshState:                getSshState,
		establishConnection:        establishConnection,
		killWorkspacePort:          killWorkspacePort,
		spawnTerminalSession:       spawnTerminalSession,
		resizeTerminalSession:      resizeTerminalSession,
		killTerminalSession:        killTerminalSession,
		stopTerminalProcess:        stopTerminalProcess,
		listTerminalSessions:       listTerminalSessions,
		waitTerminalSession:        waitTerminalSession,
		focusTerminalSession:       focusTerminalSession,
		getTerminalAgentStatus:     getTerminalAgentStatus,
		inspectTerminalProcess:     inspectTerminalProcess,
		attachPty:                  attachPty,
		attachScreencast:           attachScreencast,
		listBrowserProfiles:        listBrowserProfiles,
		createBrowserProfile:       createBrowserProfile,
		deleteBrowserProfile:       deleteBrowserProfile,
		emulatorRelay:              emulatorRelay,
		getHostCapabilities:        getHostCapabilities,
		approveDevServer:           approveDevServer,
		rejectDevServer:            rejectDevServer,
		assignDevServerGroup:       assignDevServerGroup,
		createDevServerGroup:       createDevServerGroup,
		listDevServerGroups:        listDevServerGroups,
		grantDevServerGroupAccess:  grantDevServerGroupAccess,
		revokeDevServerGroupAccess: revokeDevServerGroupAccess,
		listDevServerGroupGrants:   listDevServerGroupGrants,
		listDevServersForUser:      listDevServersForUser,
		createAccessRequest:        createAccessRequest,
		listPendingAccessRequests:  listPendingAccessRequests,
		resolveAccessRequest:       resolveAccessRequest,
		relayByDevServer:           relayByDevServer,
		isDevServerConnected:       isDevServerConnected,

		listEphemeralVmRuntimes: listEphemeralVmRuntimes,
		ephemeralVmRelay:        ephemeralVmRelay,

		getFleetConnectivitySummary: getFleetConnectivitySummary,

		teardownConnection: teardownConnection,

		streamFileChanges: streamFileChanges,
	}
}

// TeardownConnection backs BE-SOL-STORAGE-003 §5's confirmed-logout
// explicit-close path — tenant scoping comes from the authenticated
// context, per infrafleet.proto's TeardownConnectionRequest doc comment.
func (s *Server) TeardownConnection(ctx context.Context, req *infrafleetv1.TeardownConnectionRequest) (*emptypb.Empty, error) {
	if err := s.teardownConnection.Execute(ctx, req.GetConnectionId()); err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &emptypb.Empty{}, nil
}

// GetFleetConnectivitySummary backs CR-STORAGE-007's poll-driven health
// summary — see usecase.GetFleetConnectivitySummary's doc comment.
// tenant/user scoping comes from the authenticated identity in ctx, never
// from req (which is deliberately empty, see infrafleet.proto's
// GetFleetConnectivitySummaryRequest doc comment).
func (s *Server) GetFleetConnectivitySummary(ctx context.Context, req *infrafleetv1.GetFleetConnectivitySummaryRequest) (*infrafleetv1.GetFleetConnectivitySummaryResponse, error) {
	conns, err := s.getFleetConnectivitySummary.Execute(ctx)
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	out := make([]*infrafleetv1.ConnectionHealthEntry, 0, len(conns))
	for _, conn := range conns {
		out = append(out, toProtoConnectionHealthEntry(conn))
	}
	return &infrafleetv1.GetFleetConnectivitySummaryResponse{Connections: out}, nil
}

// toProtoConnectionHealthEntry maps a domain.Connection to the wire shape
// GetFleetConnectivitySummary returns — LastActivityAt/DegradedSince stay
// unset (nil) on the proto message when the domain field is nil, never a
// fabricated zero timestamp (see infrafleet.proto's ConnectionHealthEntry
// doc comment: "unset if never active" / "unset unless status == degraded").
func toProtoConnectionHealthEntry(conn domain.Connection) *infrafleetv1.ConnectionHealthEntry {
	entry := &infrafleetv1.ConnectionHealthEntry{
		ConnectionId: conn.ID,
		DevServerId:  conn.DevServerID,
		Status:       conn.Status,
	}
	if conn.LastActivityAt != nil {
		entry.LastActivityAt = timestamppb.New(*conn.LastActivityAt)
	}
	if conn.DegradedSince != nil {
		entry.DegradedSince = timestamppb.New(*conn.DegradedSince)
	}
	return entry
}

func (s *Server) RegisterDevServer(ctx context.Context, req *infrafleetv1.RegisterDevServerRequest) (*infrafleetv1.RegisterDevServerResponse, error) {
	devServer, err := s.registerDevServer.Execute(ctx, usecase.RegisterDevServerInput{
		Host:        req.GetHost(),
		Mode:        toDomainConnectionMode(req.GetMode()),
		SSHTargetID: req.GetSshTargetId(),
		Kind:        toDomainAgentKind(req.GetKind()),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &infrafleetv1.RegisterDevServerResponse{DevServer: toProtoDevServer(devServer)}, nil
}

// ResolveConnection is THE core dispatch primitive every dependent service
// calls — see usecase.ResolveConnection's doc comment.
func (s *Server) ResolveConnection(ctx context.Context, req *infrafleetv1.ResolveConnectionRequest) (*infrafleetv1.ResolveConnectionResponse, error) {
	out, err := s.resolveConnection.Execute(ctx, usecase.ResolveConnectionInput{
		ConnectionID: req.GetConnectionId(),
		DevServerID:  req.GetDevServerId(),
		WorktreeID:   req.GetWorktreeId(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	resp := &infrafleetv1.ResolveConnectionResponse{Connected: out.Connected}
	if out.Connected {
		resp.DevServer = toProtoDevServer(out.DevServer)
		resp.RepoPath = out.RepoPath
		resp.WorktreeId = out.WorktreeID
		resp.ConnectionId = out.ConnectionID
		resp.HiddenTargetId = out.HiddenTargetID
	}
	return resp, nil
}

// ListDevServers backs the frontend's devServer.list channel (wired through
// api-gateway's wscompat) — see usecase.ListDevServers's doc comment.
func (s *Server) ListDevServers(ctx context.Context, req *infrafleetv1.ListDevServersRequest) (*infrafleetv1.ListDevServersResponse, error) {
	devServers, err := s.listDevServers.Execute(ctx, toDomainAgentKind(req.GetKind()))
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	out := make([]*infrafleetv1.DevServer, 0, len(devServers))
	for _, ds := range devServers {
		out = append(out, toProtoDevServer(ds))
	}
	return &infrafleetv1.ListDevServersResponse{DevServers: out}, nil
}

// --- CR-DS-006 Phase 2 / CR-DS-007 / CR-DS-008 (dev server access control) ---

func (s *Server) ApproveDevServer(ctx context.Context, req *infrafleetv1.ApproveDevServerRequest) (*infrafleetv1.ApproveDevServerResponse, error) {
	ds, err := s.approveDevServer.Execute(ctx, req.GetDevServerId())
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &infrafleetv1.ApproveDevServerResponse{DevServer: toProtoDevServer(ds)}, nil
}

func (s *Server) RejectDevServer(ctx context.Context, req *infrafleetv1.RejectDevServerRequest) (*infrafleetv1.RejectDevServerResponse, error) {
	ds, err := s.rejectDevServer.Execute(ctx, usecase.RejectDevServerInput{
		DevServerID: req.GetDevServerId(),
		Reason:      req.GetReason(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &infrafleetv1.RejectDevServerResponse{DevServer: toProtoDevServer(ds)}, nil
}

func (s *Server) AssignDevServerGroup(ctx context.Context, req *infrafleetv1.AssignDevServerGroupRequest) (*infrafleetv1.AssignDevServerGroupResponse, error) {
	ds, err := s.assignDevServerGroup.Execute(ctx, usecase.AssignDevServerGroupInput{
		DevServerID: req.GetDevServerId(),
		GroupID:     req.GetGroupId(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &infrafleetv1.AssignDevServerGroupResponse{DevServer: toProtoDevServer(ds)}, nil
}

func (s *Server) CreateDevServerGroup(ctx context.Context, req *infrafleetv1.CreateDevServerGroupRequest) (*infrafleetv1.CreateDevServerGroupResponse, error) {
	group, err := s.createDevServerGroup.Execute(ctx, usecase.CreateDevServerGroupInput{
		Name:          req.GetName(),
		ParentGroupID: req.GetParentGroupId(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &infrafleetv1.CreateDevServerGroupResponse{Group: toProtoDevServerGroup(group)}, nil
}

func (s *Server) ListDevServerGroups(ctx context.Context, req *infrafleetv1.ListDevServerGroupsRequest) (*infrafleetv1.ListDevServerGroupsResponse, error) {
	groups, err := s.listDevServerGroups.Execute(ctx)
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	out := make([]*infrafleetv1.DevServerGroup, 0, len(groups))
	for _, g := range groups {
		out = append(out, toProtoDevServerGroup(g))
	}
	return &infrafleetv1.ListDevServerGroupsResponse{Groups: out}, nil
}

func (s *Server) GrantDevServerGroupAccess(ctx context.Context, req *infrafleetv1.GrantDevServerGroupAccessRequest) (*infrafleetv1.GrantDevServerGroupAccessResponse, error) {
	grant, err := s.grantDevServerGroupAccess.Execute(ctx, usecase.GrantDevServerGroupAccessInput{
		DevServerGroupID: req.GetDevServerGroupId(),
		GranteeKind:      toDomainGranteeKind(req.GetGranteeKind()),
		GranteeID:        req.GetGranteeId(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &infrafleetv1.GrantDevServerGroupAccessResponse{Grant: toProtoGrant(grant)}, nil
}

func (s *Server) RevokeDevServerGroupAccess(ctx context.Context, req *infrafleetv1.RevokeDevServerGroupAccessRequest) (*infrafleetv1.RevokeDevServerGroupAccessResponse, error) {
	if err := s.revokeDevServerGroupAccess.Execute(ctx, req.GetGrantId()); err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &infrafleetv1.RevokeDevServerGroupAccessResponse{}, nil
}

func (s *Server) ListDevServerGroupGrants(ctx context.Context, req *infrafleetv1.ListDevServerGroupGrantsRequest) (*infrafleetv1.ListDevServerGroupGrantsResponse, error) {
	grants, err := s.listDevServerGroupGrants.Execute(ctx, req.GetDevServerGroupId())
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	out := make([]*infrafleetv1.DevServerGroupGrant, 0, len(grants))
	for _, g := range grants {
		out = append(out, toProtoGrant(g))
	}
	return &infrafleetv1.ListDevServerGroupGrantsResponse{Grants: out}, nil
}

func (s *Server) ListDevServersForUser(ctx context.Context, req *infrafleetv1.ListDevServersForUserRequest) (*infrafleetv1.ListDevServersForUserResponse, error) {
	devServers, err := s.listDevServersForUser.Execute(ctx, usecase.ListDevServersForUserInput{
		DepartmentID: req.GetDepartmentId(),
		TeamIDs:      req.GetTeamIds(),
		Kind:         toDomainAgentKind(req.GetKind()),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	out := make([]*infrafleetv1.DevServer, 0, len(devServers))
	for _, ds := range devServers {
		out = append(out, toProtoDevServer(ds))
	}
	return &infrafleetv1.ListDevServersForUserResponse{DevServers: out}, nil
}

func (s *Server) CreateAccessRequest(ctx context.Context, req *infrafleetv1.CreateAccessRequestRequest) (*infrafleetv1.CreateAccessRequestResponse, error) {
	out, err := s.createAccessRequest.Execute(ctx, usecase.CreateAccessRequestInput{
		DevServerGroupID: req.GetDevServerGroupId(),
		Message:          req.GetMessage(),
		GranteeKind:      toDomainGranteeKind(req.GetGranteeKind()),
		GranteeID:        req.GetGranteeId(),
		NowUnixMs:        nowUnixMs(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &infrafleetv1.CreateAccessRequestResponse{Request: toProtoAccessRequest(out)}, nil
}

func (s *Server) ListPendingAccessRequests(ctx context.Context, req *infrafleetv1.ListPendingAccessRequestsRequest) (*infrafleetv1.ListPendingAccessRequestsResponse, error) {
	reqs, err := s.listPendingAccessRequests.Execute(ctx)
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	out := make([]*infrafleetv1.DevServerAccessRequest, 0, len(reqs))
	for _, r := range reqs {
		out = append(out, toProtoAccessRequest(r))
	}
	return &infrafleetv1.ListPendingAccessRequestsResponse{Requests: out}, nil
}

func (s *Server) ResolveAccessRequest(ctx context.Context, req *infrafleetv1.ResolveAccessRequestRequest) (*infrafleetv1.ResolveAccessRequestResponse, error) {
	out, err := s.resolveAccessRequest.Execute(ctx, usecase.ResolveAccessRequestInput{
		RequestID: req.GetRequestId(),
		Approve:   req.GetApprove(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	resp := &infrafleetv1.ResolveAccessRequestResponse{Request: toProtoAccessRequest(out.Request)}
	if req.GetApprove() {
		resp.Grant = toProtoGrant(out.Grant)
	}
	return resp, nil
}

// CreateConnection is the write path for infra.connections — see
// usecase.CreateConnection's doc comment.
func (s *Server) CreateConnection(ctx context.Context, req *infrafleetv1.CreateConnectionRequest) (*infrafleetv1.CreateConnectionResponse, error) {
	conn, err := s.createConnection.Execute(ctx, usecase.CreateConnectionInput{
		DevServerID: req.GetDevServerId(),
		RepoPath:    req.GetRepoPath(),
		WorktreeID:  req.GetWorktreeId(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &infrafleetv1.CreateConnectionResponse{ConnectionId: conn.ID}, nil
}

// Relay is the generic connectionId+method+params passthrough — see
// usecase.Relay's doc comment for why this is one RPC rather than one per
// caller/method.
func (s *Server) Relay(ctx context.Context, req *infrafleetv1.RelayRequest) (*infrafleetv1.RelayResponse, error) {
	var params map[string]any
	if raw := req.GetParamsJson(); raw != "" {
		if err := json.Unmarshal([]byte(raw), &params); err != nil {
			return nil, apperrors.ToGRPCStatus(apperrors.New(apperrors.KindInvalidArgument, "INFRA_RELAY_BAD_PARAMS", "params_json must be a JSON object", err))
		}
	}

	result, err := s.relay.Execute(ctx, usecase.RelayInput{
		ConnectionID: req.GetConnectionId(),
		Method:       req.GetMethod(),
		Params:       params,
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}

	resultJSON, err := json.Marshal(result)
	if err != nil {
		return nil, apperrors.ToGRPCStatus(apperrors.New(apperrors.KindInternal, "INFRA_RELAY_ENCODE_FAILED", "failed to encode relay result", err))
	}
	return &infrafleetv1.RelayResponse{ResultJson: string(resultJSON)}, nil
}

func (s *Server) RelayByDevServer(ctx context.Context, req *infrafleetv1.RelayByDevServerRequest) (*infrafleetv1.RelayResponse, error) {
	var params map[string]any
	if raw := req.GetParamsJson(); raw != "" {
		if err := json.Unmarshal([]byte(raw), &params); err != nil {
			return nil, apperrors.ToGRPCStatus(apperrors.New(apperrors.KindInvalidArgument, "INFRA_RELAY_BAD_PARAMS", "params_json must be a JSON object", err))
		}
	}

	result, err := s.relayByDevServer.Execute(ctx, usecase.RelayByDevServerInput{
		DevServerID: req.GetDevServerId(),
		Method:      req.GetMethod(),
		Params:      params,
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}

	resultJSON, err := json.Marshal(result)
	if err != nil {
		return nil, apperrors.ToGRPCStatus(apperrors.New(apperrors.KindInternal, "INFRA_RELAY_ENCODE_FAILED", "failed to encode relay result", err))
	}
	return &infrafleetv1.RelayResponse{ResultJson: string(resultJSON)}, nil
}

// StreamFileChanges is BACKLOG-003's streaming counterpart to Relay/
// RelayByDevServer above — same dual connection_id/dev_server_id
// addressing, but server-streaming (grpc.ServerStreamingServer's generated
// method shape takes (req, stream); ctx comes from stream.Context(), same
// as StreamVmProvision, not a separate parameter).
func (s *Server) StreamFileChanges(req *infrafleetv1.StreamFileChangesRequest, stream infrafleetv1.InfraFleetService_StreamFileChangesServer) error {
	events, unsubscribe, err := s.streamFileChanges.Execute(stream.Context(), usecase.StreamFileChangesInput{
		ConnectionID: req.GetConnectionId(),
		DevServerID:  req.GetDevServerId(),
		Path:         req.GetPath(),
	})
	if err != nil {
		return apperrors.ToGRPCStatus(err)
	}
	defer unsubscribe()
	for event := range events {
		if err := stream.Send(toProtoFileChangeEvent(event)); err != nil {
			return err
		}
	}
	return nil
}

func toProtoFileChangeEvent(e usecase.FileChangeEvent) *infrafleetv1.FileChangeEvent {
	return &infrafleetv1.FileChangeEvent{
		Kind:            e.Kind,
		AbsolutePath:    e.Path,
		OldAbsolutePath: e.OldPath,
		IsDirectory:     e.IsDirectory,
	}
}

func (s *Server) IsDevServerConnected(ctx context.Context, req *infrafleetv1.IsDevServerConnectedRequest) (*infrafleetv1.IsDevServerConnectedResponse, error) {
	connected, err := s.isDevServerConnected.Execute(ctx, req.GetDevServerId())
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &infrafleetv1.IsDevServerConnectedResponse{Connected: connected}, nil
}

func (s *Server) CreateSshTarget(ctx context.Context, req *infrafleetv1.CreateSshTargetRequest) (*infrafleetv1.CreateSshTargetResponse, error) {
	target, err := s.createSshTarget.Execute(ctx, usecase.CreateSshTargetInput{
		Host:         req.GetHost(),
		UserName:     req.GetUser(),
		VaultSSHRole: req.GetVaultSshRole(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &infrafleetv1.CreateSshTargetResponse{SshTargetId: target.ID}, nil
}

func (s *Server) GetFleetHealth(ctx context.Context, req *infrafleetv1.GetFleetHealthRequest) (*infrafleetv1.GetFleetHealthResponse, error) {
	statuses, err := s.getFleetHealth.Execute(ctx)
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	out := make([]*infrafleetv1.DevServerHealth, 0, len(statuses))
	for _, h := range statuses {
		out = append(out, toProtoDevServerHealth(h))
	}
	return &infrafleetv1.GetFleetHealthResponse{Statuses: out}, nil
}

func (s *Server) ScanWorkspacePorts(ctx context.Context, req *infrafleetv1.ScanWorkspacePortsRequest) (*infrafleetv1.ScanWorkspacePortsResponse, error) {
	ports, err := s.scanWorkspacePorts.Execute(ctx, usecase.ScanWorkspacePortsInput{
		ConnectionID: req.GetConnectionId(),
		WorktreeID:   req.GetWorktreeId(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &infrafleetv1.ScanWorkspacePortsResponse{OpenPorts: ports}, nil
}

func (s *Server) ListSshTargets(ctx context.Context, req *infrafleetv1.ListSshTargetsRequest) (*infrafleetv1.ListSshTargetsResponse, error) {
	targets, err := s.listSshTargets.Execute(ctx)
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	out := make([]*infrafleetv1.SshTarget, 0, len(targets))
	for _, t := range targets {
		out = append(out, &infrafleetv1.SshTarget{
			Id: t.ID, TenantId: t.TenantID, Host: t.Host, User: t.UserName, VaultSshRole: t.VaultSSHRole,
		})
	}
	return &infrafleetv1.ListSshTargetsResponse{SshTargets: out}, nil
}

func (s *Server) GetSshState(ctx context.Context, req *infrafleetv1.GetSshStateRequest) (*infrafleetv1.GetSshStateResponse, error) {
	state, err := s.getSshState.Execute(ctx, usecase.SshStateInput{SshTargetID: req.GetSshTargetId()})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	resp := &infrafleetv1.GetSshStateResponse{Connected: state.Connected, ConnectionId: state.ConnectionID}
	if state.LastActivity != nil {
		resp.LastActivityUnixMs = state.LastActivity.UnixMilli()
	}
	return resp, nil
}

func (s *Server) EstablishConnection(ctx context.Context, req *infrafleetv1.EstablishConnectionRequest) (*infrafleetv1.Connection, error) {
	conn, err := s.establishConnection.Execute(ctx, usecase.EstablishConnectionInput{SshTargetID: req.GetSshTargetId()})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	resp := &infrafleetv1.Connection{Id: conn.ID, DevServerId: conn.DevServerID, Status: conn.Status}
	if conn.LastActivityAt != nil {
		resp.EstablishedAtUnixMs = conn.LastActivityAt.UnixMilli()
	}
	return resp, nil
}

func (s *Server) KillWorkspacePort(ctx context.Context, req *infrafleetv1.KillWorkspacePortRequest) (*infrafleetv1.KillWorkspacePortResponse, error) {
	ok, reason, err := s.killWorkspacePort.Execute(ctx, usecase.KillWorkspacePortInput{
		ConnectionID: req.GetConnectionId(),
		WorktreeID:   req.GetWorktreeId(),
		PID:          req.GetPid(),
		Port:         req.GetPort(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &infrafleetv1.KillWorkspacePortResponse{Ok: ok, Reason: reason}, nil
}

// ListBrowserProfiles backs the frontend's browser.profileList channel —
// see usecase.ListBrowserProfiles's doc comment (SOL-006 Group C).
func (s *Server) ListBrowserProfiles(ctx context.Context, req *infrafleetv1.ListBrowserProfilesRequest) (*infrafleetv1.ListBrowserProfilesResponse, error) {
	profiles, err := s.listBrowserProfiles.Execute(ctx, req.GetDevServerId())
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	out := make([]*infrafleetv1.BrowserProfile, 0, len(profiles))
	for _, p := range profiles {
		out = append(out, toProtoBrowserProfile(p))
	}
	return &infrafleetv1.ListBrowserProfilesResponse{Profiles: out}, nil
}

// CreateBrowserProfile backs the frontend's browser.profileCreate channel —
// see usecase.CreateBrowserProfile's doc comment (SOL-006 Group C).
func (s *Server) CreateBrowserProfile(ctx context.Context, req *infrafleetv1.CreateBrowserProfileRequest) (*infrafleetv1.CreateBrowserProfileResponse, error) {
	profile, err := s.createBrowserProfile.Execute(ctx, usecase.CreateBrowserProfileInput{
		DevServerID:   req.GetDevServerId(),
		Name:          req.GetName(),
		SourceBrowser: req.GetSourceBrowser(),
		IsDefault:     req.GetIsDefault(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &infrafleetv1.CreateBrowserProfileResponse{Profile: toProtoBrowserProfile(profile)}, nil
}

// DeleteBrowserProfile backs the frontend's browser.profileDelete channel —
// see usecase.DeleteBrowserProfile's doc comment (SOL-006 Group C).
func (s *Server) DeleteBrowserProfile(ctx context.Context, req *infrafleetv1.DeleteBrowserProfileRequest) (*emptypb.Empty, error) {
	if err := s.deleteBrowserProfile.Execute(ctx, req.GetId()); err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &emptypb.Empty{}, nil
}

func toDomainConnectionMode(m infrafleetv1.ConnectionMode) domain.ConnectionMode {
	switch m {
	case infrafleetv1.ConnectionMode_CONNECTION_MODE_RELAY_SSH:
		return domain.ConnectionModeRelaySSH
	case infrafleetv1.ConnectionMode_CONNECTION_MODE_RELAY_WEBSOCKET:
		return domain.ConnectionModeRelayWebSocket
	case infrafleetv1.ConnectionMode_CONNECTION_MODE_DIRECT_WEBSOCKET:
		return domain.ConnectionModeDirectWebSocket
	default:
		return ""
	}
}

func toProtoConnectionMode(m domain.ConnectionMode) infrafleetv1.ConnectionMode {
	switch m {
	case domain.ConnectionModeRelaySSH:
		return infrafleetv1.ConnectionMode_CONNECTION_MODE_RELAY_SSH
	case domain.ConnectionModeRelayWebSocket:
		return infrafleetv1.ConnectionMode_CONNECTION_MODE_RELAY_WEBSOCKET
	case domain.ConnectionModeDirectWebSocket:
		return infrafleetv1.ConnectionMode_CONNECTION_MODE_DIRECT_WEBSOCKET
	default:
		return infrafleetv1.ConnectionMode_CONNECTION_MODE_UNSPECIFIED
	}
}

// toDomainAgentKind maps AGENT_KIND_UNSPECIFIED to "" (not
// domain.AgentKindDevServer) — callers that need the back-compat default
// apply it themselves (see usecase.RegisterDevServer.Execute), since a list
// filter needs to tell "unspecified = no filter" apart from an explicit
// dev-server-kind filter, which register's default-to-dev-server behavior
// would otherwise mask.
func toDomainAgentKind(k infrafleetv1.AgentKind) domain.AgentKind {
	switch k {
	case infrafleetv1.AgentKind_AGENT_KIND_DEV_SERVER:
		return domain.AgentKindDevServer
	case infrafleetv1.AgentKind_AGENT_KIND_MOBILE_EMULATOR:
		return domain.AgentKindMobileEmulator
	default:
		return ""
	}
}

func toProtoAgentKind(k domain.AgentKind) infrafleetv1.AgentKind {
	switch k {
	case domain.AgentKindDevServer:
		return infrafleetv1.AgentKind_AGENT_KIND_DEV_SERVER
	case domain.AgentKindMobileEmulator:
		return infrafleetv1.AgentKind_AGENT_KIND_MOBILE_EMULATOR
	default:
		return infrafleetv1.AgentKind_AGENT_KIND_UNSPECIFIED
	}
}

// nowUnixMs stamps DevServerAccessRequest.CreatedAtUnixMs at creation time —
// the one place in this adapter that reads wall-clock time directly (every
// other timestamp on the wire round-trips a domain.Time value instead).
func nowUnixMs() int64 {
	return time.Now().UnixMilli()
}

func toProtoDevServer(ds domain.DevServer) *infrafleetv1.DevServer {
	return &infrafleetv1.DevServer{
		Id:             ds.ID,
		TenantId:       ds.TenantID,
		Host:           ds.Host,
		Mode:           toProtoConnectionMode(ds.Mode),
		SshTargetId:    ds.SSHTargetID,
		ApprovalStatus: string(ds.Status),
		GroupId:        ds.GroupID,
		Kind:           toProtoAgentKind(ds.Kind),
		HealthStatus:   string(ds.HealthStatus),
	}
}

func toProtoDevServerGroup(g domain.DevServerGroup) *infrafleetv1.DevServerGroup {
	return &infrafleetv1.DevServerGroup{
		Id:            g.ID,
		TenantId:      g.TenantID,
		Name:          g.Name,
		ParentGroupId: g.ParentGroupID,
	}
}

func toDomainGranteeKind(k infrafleetv1.DevServerGroupGranteeKind) domain.GranteeKind {
	switch k {
	case infrafleetv1.DevServerGroupGranteeKind_DEV_SERVER_GROUP_GRANTEE_KIND_DEPARTMENT:
		return domain.GranteeKindDepartment
	case infrafleetv1.DevServerGroupGranteeKind_DEV_SERVER_GROUP_GRANTEE_KIND_TEAM:
		return domain.GranteeKindTeam
	default:
		return ""
	}
}

func toProtoGranteeKind(k domain.GranteeKind) infrafleetv1.DevServerGroupGranteeKind {
	switch k {
	case domain.GranteeKindDepartment:
		return infrafleetv1.DevServerGroupGranteeKind_DEV_SERVER_GROUP_GRANTEE_KIND_DEPARTMENT
	case domain.GranteeKindTeam:
		return infrafleetv1.DevServerGroupGranteeKind_DEV_SERVER_GROUP_GRANTEE_KIND_TEAM
	default:
		return infrafleetv1.DevServerGroupGranteeKind_DEV_SERVER_GROUP_GRANTEE_KIND_UNSPECIFIED
	}
}

func toProtoGrant(g domain.DevServerGroupGrant) *infrafleetv1.DevServerGroupGrant {
	return &infrafleetv1.DevServerGroupGrant{
		Id:               g.ID,
		TenantId:         g.TenantID,
		DevServerGroupId: g.DevServerGroupID,
		GranteeKind:      toProtoGranteeKind(g.GranteeKind),
		GranteeId:        g.GranteeID,
	}
}

func toDomainAccessRequestStatus(s domain.AccessRequestStatus) infrafleetv1.DevServerAccessRequestStatus {
	switch s {
	case domain.AccessRequestStatusPending:
		return infrafleetv1.DevServerAccessRequestStatus_DEV_SERVER_ACCESS_REQUEST_STATUS_PENDING
	case domain.AccessRequestStatusApproved:
		return infrafleetv1.DevServerAccessRequestStatus_DEV_SERVER_ACCESS_REQUEST_STATUS_APPROVED
	case domain.AccessRequestStatusRejected:
		return infrafleetv1.DevServerAccessRequestStatus_DEV_SERVER_ACCESS_REQUEST_STATUS_REJECTED
	default:
		return infrafleetv1.DevServerAccessRequestStatus_DEV_SERVER_ACCESS_REQUEST_STATUS_UNSPECIFIED
	}
}

func toProtoAccessRequest(r domain.DevServerAccessRequest) *infrafleetv1.DevServerAccessRequest {
	return &infrafleetv1.DevServerAccessRequest{
		Id:               r.ID,
		TenantId:         r.TenantID,
		UserId:           r.UserID,
		DevServerGroupId: r.DevServerGroupID,
		Status:           toDomainAccessRequestStatus(r.Status),
		Message:          r.Message,
		GranteeKind:      toProtoGranteeKind(r.GranteeKind),
		GranteeId:        r.GranteeID,
		CreatedAtUnixMs:  r.CreatedAtUnixMs,
	}
}

// --- Terminal/PTY (TASK-185) ---

func (s *Server) SpawnTerminalSession(ctx context.Context, req *infrafleetv1.SpawnTerminalSessionRequest) (*infrafleetv1.SpawnTerminalSessionResponse, error) {
	session, err := s.spawnTerminalSession.Execute(ctx, usecase.SpawnTerminalSessionInput{
		ConnectionID: req.GetConnectionId(),
		Cwd:          req.GetCwd(),
		Shell:        req.GetShell(),
		Cols:         req.GetCols(),
		Rows:         req.GetRows(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &infrafleetv1.SpawnTerminalSessionResponse{Session: toProtoTerminalSession(session)}, nil
}

func (s *Server) ResizeTerminalSession(ctx context.Context, req *infrafleetv1.ResizeTerminalSessionRequest) (*emptypb.Empty, error) {
	if err := s.resizeTerminalSession.Execute(ctx, usecase.ResizeTerminalSessionInput{PtyID: req.GetPtyId(), Cols: req.GetCols(), Rows: req.GetRows()}); err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &emptypb.Empty{}, nil
}

func (s *Server) KillTerminalSession(ctx context.Context, req *infrafleetv1.KillTerminalSessionRequest) (*emptypb.Empty, error) {
	if err := s.killTerminalSession.Execute(ctx, req.GetPtyId()); err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &emptypb.Empty{}, nil
}

func (s *Server) StopTerminalProcess(ctx context.Context, req *infrafleetv1.StopTerminalProcessRequest) (*emptypb.Empty, error) {
	if err := s.stopTerminalProcess.Execute(ctx, req.GetPtyId()); err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &emptypb.Empty{}, nil
}

func (s *Server) ListTerminalSessions(ctx context.Context, req *infrafleetv1.ListTerminalSessionsRequest) (*infrafleetv1.ListTerminalSessionsResponse, error) {
	sessions, err := s.listTerminalSessions.Execute(ctx, usecase.ListTerminalSessionsInput{ConnectionID: req.GetConnectionId()})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	out := make([]*infrafleetv1.TerminalSession, 0, len(sessions))
	for _, session := range sessions {
		out = append(out, toProtoTerminalSession(session))
	}
	return &infrafleetv1.ListTerminalSessionsResponse{Sessions: out}, nil
}

func (s *Server) WaitTerminalSession(ctx context.Context, req *infrafleetv1.WaitTerminalSessionRequest) (*infrafleetv1.WaitTerminalSessionResponse, error) {
	result, err := s.waitTerminalSession.Execute(ctx, usecase.WaitTerminalSessionInput{PtyID: req.GetPtyId(), TimeoutMs: req.GetTimeoutMs()})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &infrafleetv1.WaitTerminalSessionResponse{Exited: result.Exited, ExitCode: result.ExitCode, TimedOut: result.TimedOut}, nil
}

func (s *Server) FocusTerminalSession(ctx context.Context, req *infrafleetv1.FocusTerminalSessionRequest) (*emptypb.Empty, error) {
	if err := s.focusTerminalSession.Execute(ctx, req.GetPtyId()); err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &emptypb.Empty{}, nil
}

func (s *Server) GetTerminalAgentStatus(ctx context.Context, req *infrafleetv1.GetTerminalAgentStatusRequest) (*infrafleetv1.GetTerminalAgentStatusResponse, error) {
	result, err := s.getTerminalAgentStatus.Execute(ctx, req.GetPtyId())
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &infrafleetv1.GetTerminalAgentStatusResponse{
		AgentRunning:  result.AgentRunning,
		AgentKind:     result.AgentKind,
		ReadyForInput: result.ReadyForInput,
	}, nil
}

func (s *Server) InspectTerminalProcess(ctx context.Context, req *infrafleetv1.InspectTerminalProcessRequest) (*infrafleetv1.InspectTerminalProcessResponse, error) {
	result, err := s.inspectTerminalProcess.Execute(ctx, req.GetPtyId())
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &infrafleetv1.InspectTerminalProcessResponse{
		Known:   result.Known,
		Pid:     result.Pid,
		Command: result.Command,
		Cwd:     result.Cwd,
	}, nil
}

// AttachPty implements the bidirectional streaming RPC: pumps
// stream.Recv() into an inbound channel usecase.AttachPty.Execute consumes,
// and pumps its two returned channels (outbound, errCh) back into
// stream.Send()/the final returned error.
//
// Tenant extraction: grpcmw.ChainUnary only wires a UnaryServerInterceptor
// chain (see that function's doc comment) — there is no stream-interceptor
// counterpart registered in cmd/server/main.go, so a streaming RPC's ctx
// does NOT get tenant.WithTenantID applied automatically the way every
// unary handler's does. This handler works around that gap locally (mirrors
// grpcmw.TenantExtractionInterceptor's own metadata-read exactly) rather
// than editing the shared common/grpcmw package, which would widen this
// pass's blast radius beyond this one streaming RPC. FLAGGED as a known gap:
// a real stream interceptor in common/grpcmw would be the more correct fix
// if more streaming RPCs are added later.
func (s *Server) AttachPty(stream infrafleetv1.InfraFleetService_AttachPtyServer) error {
	ctx := withTenantFromStreamMetadata(stream.Context())

	inbound := make(chan usecase.PtyClientMessage)
	go pumpAttachPtyInbound(stream, inbound)

	outbound, errCh := s.attachPty.Execute(ctx, inbound)
	for {
		select {
		case msg, ok := <-outbound:
			if !ok {
				outbound = nil
				continue
			}
			if err := stream.Send(toProtoPtyServerFrame(msg)); err != nil {
				return err
			}
		case err, ok := <-errCh:
			if !ok {
				return nil
			}
			if err != nil {
				return apperrors.ToGRPCStatus(err)
			}
			return nil
		}
		if outbound == nil {
			// outbound closed — drain errCh for the final (possibly nil) error.
			if err := <-errCh; err != nil {
				return apperrors.ToGRPCStatus(err)
			}
			return nil
		}
	}
}

// pumpAttachPtyInbound reads stream.Recv() until it errors/EOFs, translating
// each PtyClientFrame into usecase.PtyClientMessage and pushing it onto
// inbound; closes inbound when the client stream ends so
// usecase.AttachPty.run's read loop observes !ok and returns.
func pumpAttachPtyInbound(stream infrafleetv1.InfraFleetService_AttachPtyServer, inbound chan<- usecase.PtyClientMessage) {
	defer close(inbound)
	for {
		frame, err := stream.Recv()
		if err != nil {
			return // io.EOF (client closed send side) or a real transport error — either way, stop
		}
		msg, ok := toUsecasePtyClientMessage(frame)
		if !ok {
			continue // frame carried no oneof variant — ignore rather than error the whole stream
		}
		select {
		case inbound <- msg:
		case <-stream.Context().Done():
			return
		}
	}
}

// AttachScreencast mirrors AttachPty's shape exactly (same tenant-extraction
// workaround, same pump-inbound/pump-outbound structure) — see AttachPty's
// doc comment for why the manual withTenantFromStreamMetadata call is
// needed here too.
func (s *Server) AttachScreencast(stream infrafleetv1.InfraFleetService_AttachScreencastServer) error {
	ctx := withTenantFromStreamMetadata(stream.Context())

	inbound := make(chan usecase.ScreencastClientMessage)
	go pumpAttachScreencastInbound(stream, inbound)

	outbound, errCh := s.attachScreencast.Execute(ctx, inbound)
	for {
		select {
		case msg, ok := <-outbound:
			if !ok {
				outbound = nil
				continue
			}
			if err := stream.Send(toProtoScreencastServerFrame(msg)); err != nil {
				return err
			}
		case err, ok := <-errCh:
			if !ok {
				return nil
			}
			if err != nil {
				return apperrors.ToGRPCStatus(err)
			}
			return nil
		}
		if outbound == nil {
			if err := <-errCh; err != nil {
				return apperrors.ToGRPCStatus(err)
			}
			return nil
		}
	}
}

func pumpAttachScreencastInbound(stream infrafleetv1.InfraFleetService_AttachScreencastServer, inbound chan<- usecase.ScreencastClientMessage) {
	defer close(inbound)
	for {
		frame, err := stream.Recv()
		if err != nil {
			return
		}
		msg, ok := toUsecaseScreencastClientMessage(frame)
		if !ok {
			continue
		}
		select {
		case inbound <- msg:
		case <-stream.Context().Done():
			return
		}
	}
}

func withTenantFromStreamMetadata(ctx context.Context) context.Context {
	md, ok := metadata.FromIncomingContext(ctx)
	if !ok {
		return ctx
	}
	if v := md.Get(grpcmw.MetadataTenantID); len(v) > 0 && v[0] != "" {
		ctx = tenant.WithTenantID(ctx, v[0])
	}
	if v := md.Get(grpcmw.MetadataUserID); len(v) > 0 && v[0] != "" {
		ctx = tenant.WithUserID(ctx, v[0])
	}
	return ctx
}

func toUsecasePtyClientMessage(frame *infrafleetv1.PtyClientFrame) (usecase.PtyClientMessage, bool) {
	switch f := frame.GetFrame().(type) {
	case *infrafleetv1.PtyClientFrame_Attach:
		return usecase.PtyClientMessage{Attach: &usecase.PtyAttachMessage{PtyID: f.Attach.GetPtyId()}}, true
	case *infrafleetv1.PtyClientFrame_Input:
		return usecase.PtyClientMessage{Input: f.Input.GetData()}, true
	case *infrafleetv1.PtyClientFrame_Resize:
		return usecase.PtyClientMessage{Resize: &usecase.PtyResizeMessage{Cols: f.Resize.GetCols(), Rows: f.Resize.GetRows()}}, true
	default:
		return usecase.PtyClientMessage{}, false
	}
}

func toProtoPtyServerFrame(msg usecase.PtyServerMessage) *infrafleetv1.PtyServerFrame {
	if msg.Exited {
		return &infrafleetv1.PtyServerFrame{Frame: &infrafleetv1.PtyServerFrame_Exited{Exited: &infrafleetv1.PtyExited{ExitCode: msg.ExitCode}}}
	}
	return &infrafleetv1.PtyServerFrame{Frame: &infrafleetv1.PtyServerFrame_Out{Out: &infrafleetv1.PtyOutput{Data: msg.Output}}}
}

func toUsecaseScreencastClientMessage(frame *infrafleetv1.ScreencastClientFrame) (usecase.ScreencastClientMessage, bool) {
	switch f := frame.GetFrame().(type) {
	case *infrafleetv1.ScreencastClientFrame_Start:
		start := f.Start
		params := usecase.ScreencastParams{
			WorktreeID: start.GetWorktreeId(), Page: start.GetPage(), Format: start.GetFormat(),
			Quality: start.GetQuality(), MaxWidth: start.GetMaxWidth(), MaxHeight: start.GetMaxHeight(),
			Mobile: start.GetMobile(), EveryNthFrame: start.GetEveryNthFrame(), MinFrameIntervalMs: start.GetMinFrameIntervalMs(),
		}
		if start.ViewportWidth != nil {
			v := start.GetViewportWidth()
			params.ViewportWidth = &v
		}
		if start.ViewportHeight != nil {
			v := start.GetViewportHeight()
			params.ViewportHeight = &v
		}
		if start.DeviceScaleFactor != nil {
			v := start.GetDeviceScaleFactor()
			params.DeviceScaleFactor = &v
		}
		return usecase.ScreencastClientMessage{Start: &usecase.ScreencastStartMessage{Params: params}}, true
	case *infrafleetv1.ScreencastClientFrame_Stop:
		return usecase.ScreencastClientMessage{Stop: true}, true
	default:
		return usecase.ScreencastClientMessage{}, false
	}
}

func toProtoScreencastServerFrame(ev usecase.ScreencastEvent) *infrafleetv1.ScreencastServerFrame {
	switch {
	case ev.Ready:
		return &infrafleetv1.ScreencastServerFrame{Frame: &infrafleetv1.ScreencastServerFrame_Ready{Ready: &infrafleetv1.ScreencastReady{
			SubscriptionId: ev.SubscriptionID, BrowserPageId: ev.BrowserPageID, Format: ev.Format,
		}}}
	case ev.Ended:
		return &infrafleetv1.ScreencastServerFrame{Frame: &infrafleetv1.ScreencastServerFrame_Ended{Ended: &infrafleetv1.ScreencastEnded{}}}
	case ev.ErrorMsg != "":
		return &infrafleetv1.ScreencastServerFrame{Frame: &infrafleetv1.ScreencastServerFrame_Error{Error: &infrafleetv1.ScreencastError{Message: ev.ErrorMsg}}}
	default:
		return &infrafleetv1.ScreencastServerFrame{Frame: &infrafleetv1.ScreencastServerFrame_FrameData{FrameData: &infrafleetv1.ScreencastFrame{Data: ev.Frame}}}
	}
}

func toProtoTerminalSession(session domain.TerminalSession) *infrafleetv1.TerminalSession {
	return &infrafleetv1.TerminalSession{
		PtyId:              session.PtyID,
		ConnectionId:       session.ConnectionID,
		Cwd:                session.Cwd,
		CreatedAtUnixMs:    session.CreatedAt.UnixMilli(),
		LastActiveAtUnixMs: session.LastActiveAt.UnixMilli(),
	}
}

func toProtoBrowserProfile(p domain.BrowserProfile) *infrafleetv1.BrowserProfile {
	return &infrafleetv1.BrowserProfile{
		Id:            p.ID,
		TenantId:      p.TenantID,
		DevServerId:   p.DevServerID,
		Name:          p.Name,
		SourceBrowser: p.SourceBrowser,
		IsDefault:     p.IsDefault,
		CreatedAt:     timestamppb.New(p.CreatedAt),
	}
}

func toProtoDevServerHealth(h domain.DevServerHealth) *infrafleetv1.DevServerHealth {
	return &infrafleetv1.DevServerHealth{
		DevServerId: h.DevServerID,
		Reachable:   h.Reachable,
		CpuPercent:  h.CPUPercent,
		RamPercent:  h.RAMPercent,
		DiskPercent: h.DiskPercent,
		LatencyMs:   h.LatencyMS,
	}
}
