// Package grpc implements the generated
// orchestrationv1.OrchestrationServiceServer interface by translating wire
// messages to/from usecase calls — no business logic here, per
// specs/backend-go/architecture/03-clean-architecture-guidelines.md's
// inbound-adapter contract.
package grpc

import (
	"context"
	"time"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/services/orchestration-service/internal/domain"
	"github.com/stablyai/orca-go/services/orchestration-service/internal/usecase"

	orchestrationv1 "github.com/stablyai/orca-go/proto/gen/go/orca/orchestration/v1"
)

// Server implements orchestrationv1.UnimplementedOrchestrationServiceServer.
type Server struct {
	orchestrationv1.UnimplementedOrchestrationServiceServer

	createDispatchContext             *usecase.CreateDispatchContext
	createGate                        *usecase.CreateGate
	resolveGate                       *usecase.ResolveGate
	updateTaskStatusAndPromote        *usecase.UpdateTaskStatusAndPromote
	getDispatchContextForTask         *usecase.GetDispatchContextForTask
	listActiveDispatchContextsForUser *usecase.ListActiveDispatchContextsForUser
	failDispatch                      *usecase.FailDispatch
}

func New(
	createDispatchContext *usecase.CreateDispatchContext,
	createGate *usecase.CreateGate,
	resolveGate *usecase.ResolveGate,
	updateTaskStatusAndPromote *usecase.UpdateTaskStatusAndPromote,
	getDispatchContextForTask *usecase.GetDispatchContextForTask,
	listActiveDispatchContextsForUser *usecase.ListActiveDispatchContextsForUser,
	failDispatch *usecase.FailDispatch,
) *Server {
	return &Server{
		createDispatchContext:             createDispatchContext,
		createGate:                        createGate,
		resolveGate:                       resolveGate,
		updateTaskStatusAndPromote:        updateTaskStatusAndPromote,
		getDispatchContextForTask:         getDispatchContextForTask,
		listActiveDispatchContextsForUser: listActiveDispatchContextsForUser,
		failDispatch:                      failDispatch,
	}
}

func (s *Server) CreateDispatchContext(ctx context.Context, req *orchestrationv1.CreateDispatchContextRequest) (*orchestrationv1.CreateDispatchContextResponse, error) {
	dc, err := s.createDispatchContext.Execute(ctx, usecase.CreateDispatchContextInput{
		Handle:              req.GetHandle(),
		CoordinatorRunID:    req.GetCoordinatorRunId(),
		OrchestrationTaskID: req.GetOrchestrationTaskId(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &orchestrationv1.CreateDispatchContextResponse{
		Context: toProtoDispatchContext(dc),
	}, nil
}

func (s *Server) ListActiveDispatchContextsForUser(ctx context.Context, _ *orchestrationv1.ListActiveDispatchContextsForUserRequest) (*orchestrationv1.ListActiveDispatchContextsForUserResponse, error) {
	contexts, err := s.listActiveDispatchContextsForUser.Execute(ctx)
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	out := make([]*orchestrationv1.DispatchContext, 0, len(contexts))
	for _, dc := range contexts {
		out = append(out, toProtoDispatchContext(dc))
	}
	return &orchestrationv1.ListActiveDispatchContextsForUserResponse{DispatchContexts: out}, nil
}

// toProtoDispatchContext maps a domain.DispatchContext to its proto wire
// shape, shared by every handler that returns one (CreateDispatchContext,
// GetDispatchContextForTask, ListActiveDispatchContextsForUser) so the
// mapping can't drift between them.
func toProtoDispatchContext(dc domain.DispatchContext) *orchestrationv1.DispatchContext {
	var lastHeartbeatAt string
	if !dc.LastHeartbeatAt.IsZero() {
		lastHeartbeatAt = dc.LastHeartbeatAt.Format(time.RFC3339)
	}
	return &orchestrationv1.DispatchContext{
		Id:                  dc.ID,
		Handle:              dc.Handle,
		CoordinatorRunId:    dc.CoordinatorRunID,
		OrchestrationTaskId: dc.OrchestrationTaskID,
		UserId:              dc.UserID,
		Status:              string(dc.Status),
		FailureCount:        dc.FailureCount,
		LastHeartbeatAt:     lastHeartbeatAt,
	}
}

func (s *Server) CreateGate(ctx context.Context, req *orchestrationv1.CreateGateRequest) (*orchestrationv1.CreateGateResponse, error) {
	// req.GetOrchestrationTaskId() is intentionally not read: CreateGate
	// derives the owning task from DispatchContextID itself via a locked
	// read inside its transaction (see usecase/create_gate.go), a
	// deliberate derive-not-trust boundary — see docs/execution-plan.md
	// Epic C and CreateGateRequest's doc comment in the proto.
	gate, err := s.createGate.Execute(ctx, usecase.CreateGateInput{
		DispatchContextID: req.GetDispatchContextId(),
		Question:          req.GetQuestion(),
		Options:           req.GetOptions(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &orchestrationv1.CreateGateResponse{
		Gate: &orchestrationv1.DecisionGate{
			Id:                gate.ID,
			DispatchContextId: gate.DispatchContextID,
			Status:            string(gate.Status),
			Question:          gate.Question,
			Options:           gate.Options,
		},
	}, nil
}

func (s *Server) ResolveGate(ctx context.Context, req *orchestrationv1.ResolveGateRequest) (*orchestrationv1.ResolveGateResponse, error) {
	out, err := s.resolveGate.Execute(ctx, usecase.ResolveGateInput{
		GateID:      req.GetGateId(),
		OutcomeJSON: req.GetOutcomeJson(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &orchestrationv1.ResolveGateResponse{
		Gate: &orchestrationv1.DecisionGate{
			Id:                out.Gate.ID,
			DispatchContextId: out.Gate.DispatchContextID,
			Status:            string(out.Gate.Status),
			Question:          out.Gate.Question,
			Options:           out.Gate.Options,
		},
	}, nil
}

func (s *Server) UpdateTaskStatusAndPromote(ctx context.Context, req *orchestrationv1.UpdateTaskStatusAndPromoteRequest) (*orchestrationv1.UpdateTaskStatusAndPromoteResponse, error) {
	out, err := s.updateTaskStatusAndPromote.Execute(ctx, usecase.UpdateTaskStatusAndPromoteInput{
		OrchestrationTaskID: req.GetOrchestrationTaskId(),
		NewStatus:           req.GetNewStatus(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &orchestrationv1.UpdateTaskStatusAndPromoteResponse{
		PromotedTaskIds: out.PromotedTaskIDs,
	}, nil
}

func (s *Server) GetDispatchContextForTask(ctx context.Context, req *orchestrationv1.GetDispatchContextForTaskRequest) (*orchestrationv1.GetDispatchContextForTaskResponse, error) {
	dc, found, err := s.getDispatchContextForTask.Execute(ctx, req.GetOrchestrationTaskId())
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	if !found {
		return &orchestrationv1.GetDispatchContextForTaskResponse{}, nil
	}
	return &orchestrationv1.GetDispatchContextForTaskResponse{
		Dispatch: toProtoDispatchContext(dc),
	}, nil
}

func (s *Server) FailDispatch(ctx context.Context, req *orchestrationv1.FailDispatchRequest) (*orchestrationv1.FailDispatchResponse, error) {
	out, err := s.failDispatch.Execute(ctx, usecase.FailDispatchInput{
		DispatchContextID: req.GetDispatchContextId(),
		ErrorMessage:      req.GetErrorMessage(),
		GRPCStatusCode:    req.GetGrpcStatusCode(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	resp := &orchestrationv1.FailDispatchResponse{Recorded: out.Recorded}
	if out.Recorded {
		resp.Context = toProtoDispatchContext(out.Context)
	}
	return resp, nil
}
