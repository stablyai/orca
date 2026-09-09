// Handlers for ephemeralVm.* (SOL-004 Group 1/2a) — split out of server.go
// per this package's growing size, not because these RPCs differ
// structurally from any other handler here.
package grpc

import (
	"context"

	"google.golang.org/protobuf/types/known/timestamppb"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/services/infra-fleet-service/internal/domain"
	"github.com/stablyai/orca-go/services/infra-fleet-service/internal/usecase"

	infrafleetv1 "github.com/stablyai/orca-go/proto/gen/go/orca/infrafleet/v1"
)

func (s *Server) ListEphemeralVmRuntimes(ctx context.Context, _ *infrafleetv1.ListEphemeralVmRuntimesRequest) (*infrafleetv1.ListEphemeralVmRuntimesResponse, error) {
	runtimes, err := s.listEphemeralVmRuntimes.Execute(ctx)
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	out := make([]*infrafleetv1.EphemeralVmRuntime, 0, len(runtimes))
	for _, r := range runtimes {
		out = append(out, toProtoEphemeralVmRuntime(r))
	}
	return &infrafleetv1.ListEphemeralVmRuntimesResponse{Runtimes: out}, nil
}

func toProtoEphemeralVmRuntime(r domain.EphemeralVmRuntime) *infrafleetv1.EphemeralVmRuntime {
	return &infrafleetv1.EphemeralVmRuntime{
		Id: r.ID, RepoId: r.RepoID, RecipeId: r.RecipeID, ConnectionType: r.ConnectionType,
		Status: r.Status, EnvironmentId: r.EnvironmentID, WorkspaceId: r.WorkspaceID, LastError: r.LastError,
		CreatedAt: timestamppb.New(r.CreatedAt), UpdatedAt: timestamppb.New(r.UpdatedAt),
	}
}

func (s *Server) AttachEphemeralVmWorkspace(ctx context.Context, req *infrafleetv1.AttachEphemeralVmWorkspaceRequest) (*infrafleetv1.EphemeralVmRuntime, error) {
	runtime, err := s.ephemeralVmRelay.AttachWorkspace(ctx, req.GetRuntimeId(), req.GetWorkspaceId())
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return toProtoEphemeralVmRuntime(runtime), nil
}

func (s *Server) SuspendEphemeralVmWorkspace(ctx context.Context, req *infrafleetv1.SuspendEphemeralVmWorkspaceRequest) (*infrafleetv1.EphemeralVmRuntime, error) {
	runtime, err := s.ephemeralVmRelay.SuspendWorkspace(ctx, req.GetConnectionId(), req.GetWorkspaceId(), req.GetCommand())
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return toProtoEphemeralVmRuntime(runtime), nil
}

func (s *Server) ResumeEphemeralVmWorkspace(ctx context.Context, req *infrafleetv1.ResumeEphemeralVmWorkspaceRequest) (*infrafleetv1.EphemeralVmRuntime, error) {
	runtime, err := s.ephemeralVmRelay.ResumeWorkspace(ctx, req.GetConnectionId(), req.GetWorkspaceId(), req.GetCommand())
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return toProtoEphemeralVmRuntime(runtime), nil
}

func (s *Server) CleanupEphemeralVmWorkspace(ctx context.Context, req *infrafleetv1.CleanupEphemeralVmWorkspaceRequest) (*infrafleetv1.EphemeralVmRuntime, error) {
	runtime, err := s.ephemeralVmRelay.CleanupWorkspace(ctx, req.GetConnectionId(), req.GetRuntimeId(), req.GetCommand())
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return toProtoEphemeralVmRuntime(runtime), nil
}

// StreamVmProvision is TASK-BE-EVM-004's Provision usecase's gRPC-facing
// counterpart — missing from this file until this pass (TASK-BE-EVM-002's
// proto/TASK-BE-EVM-004's usecase both landed without it; added now because
// TASK-BE-EVM-005's wscompat layer has nothing to call otherwise).
// grpc.ServerStreamingServer[VmProvisionEvent]'s generated method shape
// takes (req, stream) — ctx comes from stream.Context(), not a separate
// parameter, unlike every unary handler above.
func (s *Server) StreamVmProvision(req *infrafleetv1.StreamVmProvisionRequest, stream infrafleetv1.InfraFleetService_StreamVmProvisionServer) error {
	events, unsubscribe, err := s.ephemeralVmRelay.Provision(stream.Context(), req.GetConnectionId(), req.GetRecipeId(), req.GetRuntimeId(), req.GetCommand())
	if err != nil {
		return apperrors.ToGRPCStatus(err)
	}
	defer unsubscribe()
	for event := range events {
		if err := stream.Send(toProtoVmProvisionEvent(event)); err != nil {
			return err
		}
	}
	return nil
}

// toProtoVmProvisionEvent maps usecase.VmProvisionEvent onto the wire
// message. VmProvisionEvent (proto, TASK-BE-EVM-002) has no dedicated
// error-message field — chunk is reused to carry the error text for
// Type=="error" events (both fields are plain strings the frontend already
// treats as opaque payload for their respective event types, and adding a
// 4th field for a value chunk already structurally accommodates was not
// worth another proto/buf-generate pass).
func toProtoVmProvisionEvent(e usecase.VmProvisionEvent) *infrafleetv1.VmProvisionEvent {
	out := &infrafleetv1.VmProvisionEvent{Type: e.Type}
	switch e.Type {
	case "result":
		out.Result = toProtoVmProvisionResult(e.Result)
	case "error":
		out.Chunk = e.ErrorMsg
	default: // "stdout" | "stderr"
		out.Chunk = e.Chunk
	}
	return out
}

// toProtoPortForwards mirrors toUsecasePortForwards (devserveragent/client.go)
// in the opposite direction — CR-EVM-008/TASK-BE-EVM-021.
func toProtoPortForwards(forwards []usecase.PortForward) []*infrafleetv1.PortForward {
	if len(forwards) == 0 {
		return nil
	}
	out := make([]*infrafleetv1.PortForward, len(forwards))
	for i, f := range forwards {
		out[i] = &infrafleetv1.PortForward{
			LocalPort:  f.LocalPort,
			RemoteHost: f.RemoteHost,
			RemotePort: f.RemotePort,
			Label:      f.Label,
		}
	}
	return out
}

func toProtoVmProvisionResult(r usecase.VmProvisionResult) *infrafleetv1.VmProvisionResult {
	out := &infrafleetv1.VmProvisionResult{Type: r.Type, PairingCode: r.PairingCode, ProjectRoot: r.ProjectRoot}
	if r.SshTarget != nil {
		out.SshTarget = &infrafleetv1.EphemeralVmRecipeSshTarget{
			Label: r.SshTarget.Label, Host: r.SshTarget.Host, Port: r.SshTarget.Port, Username: r.SshTarget.Username,
			IdentityFile: r.SshTarget.IdentityFile, IdentityAgent: r.SshTarget.IdentityAgent,
			IdentitiesOnly: r.SshTarget.IdentitiesOnly, ProxyCommand: r.SshTarget.ProxyCommand,
			JumpHost: r.SshTarget.JumpHost, RelayGracePeriodSeconds: r.SshTarget.RelayGracePeriodSeconds,
			PortForwards: toProtoPortForwards(r.SshTarget.PortForwards),
		}
	}
	return out
}
