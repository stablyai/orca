// Package grpc implements the generated taskv1.TaskServiceServer interface
// by translating wire messages to/from usecase calls — no business logic
// here, per specs/backend-go/architecture/03-clean-architecture-guidelines.md's
// inbound-adapter contract.
package grpc

import (
	"context"

	"google.golang.org/protobuf/types/known/emptypb"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/services/task-service/internal/domain"
	"github.com/stablyai/orca-go/services/task-service/internal/usecase"

	taskv1 "github.com/stablyai/orca-go/proto/gen/go/orca/task/v1"
)

// Server implements taskv1.UnimplementedTaskServiceServer.
type Server struct {
	taskv1.UnimplementedTaskServiceServer

	createTask          *usecase.CreateTask
	getTask             *usecase.GetTask
	addEdge             *usecase.AddEdge
	grant               *usecase.Grant
	resolvePermission   *usecase.ResolvePermission
	executeTask         *usecase.ExecuteTask
	hasActiveExecutions *usecase.HasActiveExecutions
	listTasks           *usecase.ListTasks
	updateTask          *usecase.UpdateTask
	deleteTask          *usecase.DeleteTask
	getDependencies     *usecase.GetDependencies
	aiDecompose         *usecase.AIDecompose
	aiApply             *usecase.AIApply
}

func New(
	createTask *usecase.CreateTask,
	getTask *usecase.GetTask,
	addEdge *usecase.AddEdge,
	grant *usecase.Grant,
	resolvePermission *usecase.ResolvePermission,
	executeTask *usecase.ExecuteTask,
	hasActiveExecutions *usecase.HasActiveExecutions,
	listTasks *usecase.ListTasks,
	updateTask *usecase.UpdateTask,
	deleteTask *usecase.DeleteTask,
	getDependencies *usecase.GetDependencies,
	aiDecompose *usecase.AIDecompose,
	aiApply *usecase.AIApply,
) *Server {
	return &Server{
		createTask:          createTask,
		getTask:             getTask,
		addEdge:             addEdge,
		grant:               grant,
		resolvePermission:   resolvePermission,
		executeTask:         executeTask,
		hasActiveExecutions: hasActiveExecutions,
		listTasks:           listTasks,
		updateTask:          updateTask,
		deleteTask:          deleteTask,
		getDependencies:     getDependencies,
		aiDecompose:         aiDecompose,
		aiApply:             aiApply,
	}
}

func (s *Server) CreateTask(ctx context.Context, req *taskv1.CreateTaskRequest) (*taskv1.CreateTaskResponse, error) {
	// No ID field on CreateTaskRequest — the usecase assigns one (uuid) when
	// Input.ID is left empty.
	task, err := s.createTask.Execute(ctx, usecase.CreateTaskInput{
		Title:     req.GetTitle(),
		ParentID:  req.GetParentId(),
		ProjectID: req.GetProjectId(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &taskv1.CreateTaskResponse{Task: toProtoTask(task)}, nil
}

func (s *Server) GetTask(ctx context.Context, req *taskv1.GetTaskRequest) (*taskv1.GetTaskResponse, error) {
	task, err := s.getTask.Execute(ctx, req.GetId())
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &taskv1.GetTaskResponse{Task: toProtoTask(task)}, nil
}

func (s *Server) AddEdge(ctx context.Context, req *taskv1.AddEdgeRequest) (*taskv1.AddEdgeResponse, error) {
	_, err := s.addEdge.Execute(ctx, usecase.AddEdgeInput{
		FromTaskID: req.GetFromTaskId(),
		ToTaskID:   req.GetToTaskId(),
		Kind:       toDomainEdgeKind(req.GetType()),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &taskv1.AddEdgeResponse{}, nil
}

func (s *Server) Grant(ctx context.Context, req *taskv1.GrantRequest) (*taskv1.GrantResponse, error) {
	err := s.grant.Execute(ctx, usecase.GrantInput{
		TaskID:    req.GetTaskId(),
		SubjectID: req.GetSubjectId(),
		Level:     toDomainGrantLevel(req.GetLevel()),
		ApplyTree: req.GetApplyTree(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &taskv1.GrantResponse{}, nil
}

func (s *Server) ResolvePermission(ctx context.Context, req *taskv1.ResolvePermissionRequest) (*taskv1.ResolvePermissionResponse, error) {
	level, err := s.resolvePermission.Execute(ctx, usecase.ResolvePermissionInput{
		TaskID: req.GetTaskId(),
		UserID: req.GetUserId(),
		// ResolvePermissionRequest has no action-equivalent field yet (see
		// this service's README "Known gaps") — default to "read", the one
		// action task_grant.rego's level_actions table authorizes for
		// every named GrantLevel, so a resolved grant of any kind still
		// passes the OPA check until the wire contract grows a real field.
		Action: "read",
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &taskv1.ResolvePermissionResponse{EffectiveLevel: toProtoGrantLevel(level)}, nil
}

func (s *Server) Execute(ctx context.Context, req *taskv1.TaskServiceExecuteRequest) (*taskv1.TaskServiceExecuteResponse, error) {
	ref, err := s.executeTask.Execute(ctx, usecase.ExecuteTaskInput{
		TaskID:    req.GetTaskId(),
		RequestID: req.GetRequestId(),
		Prompt:    req.GetPrompt(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &taskv1.TaskServiceExecuteResponse{ExecutionRef: ref}, nil
}

func (s *Server) HasActiveExecutions(ctx context.Context, req *taskv1.HasActiveExecutionsRequest) (*taskv1.HasActiveExecutionsResponse, error) {
	hasActive, err := s.hasActiveExecutions.Execute(ctx, usecase.HasActiveExecutionsInput{ProjectID: req.GetProjectId()})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &taskv1.HasActiveExecutionsResponse{HasActive: hasActive}, nil
}

func (s *Server) ListTasks(ctx context.Context, req *taskv1.ListTasksRequest) (*taskv1.ListTasksResponse, error) {
	result, err := s.listTasks.Execute(ctx, usecase.ListTasksInput{
		ProjectID: req.GetProjectId(),
		PageToken: req.GetPageToken(),
		PageSize:  req.GetPageSize(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	out := make([]*taskv1.Task, 0, len(result.Tasks))
	for _, t := range result.Tasks {
		out = append(out, toProtoTask(t))
	}
	return &taskv1.ListTasksResponse{Tasks: out, NextPageToken: result.NextPageToken}, nil
}

func (s *Server) UpdateTask(ctx context.Context, req *taskv1.UpdateTaskRequest) (*taskv1.UpdateTaskResponse, error) {
	in := usecase.UpdateTaskInput{ID: req.GetId()}
	if req.GetTitle() != nil {
		v := req.GetTitle().GetValue()
		in.Title = &v
	}
	if req.GetStatus() != nil {
		v := req.GetStatus().GetValue()
		in.Status = &v
	}
	if req.GetWorkflowTemplateId() != nil {
		v := req.GetWorkflowTemplateId().GetValue()
		in.WorkflowTemplateID = &v
	}
	task, err := s.updateTask.Execute(ctx, in)
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &taskv1.UpdateTaskResponse{Task: toProtoTask(task)}, nil
}

func (s *Server) DeleteTask(ctx context.Context, req *taskv1.DeleteTaskRequest) (*emptypb.Empty, error) {
	if err := s.deleteTask.Execute(ctx, usecase.DeleteTaskInput{ID: req.GetId()}); err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &emptypb.Empty{}, nil
}

func (s *Server) GetDependencies(ctx context.Context, req *taskv1.GetDependenciesRequest) (*taskv1.GetDependenciesResponse, error) {
	deps, err := s.getDependencies.Execute(ctx, usecase.GetDependenciesInput{TaskID: req.GetTaskId()})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	out := make([]*taskv1.Task, 0, len(deps))
	for _, t := range deps {
		out = append(out, toProtoTask(t))
	}
	return &taskv1.GetDependenciesResponse{Dependencies: out}, nil
}

func (s *Server) AIDecompose(ctx context.Context, req *taskv1.AIDecomposeRequest) (*taskv1.AIDecomposeResponse, error) {
	proposals, err := s.aiDecompose.Execute(ctx, usecase.AIDecomposeInput{TaskID: req.GetTaskId()})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &taskv1.AIDecomposeResponse{Proposals: toProtoSubtaskProposals(proposals)}, nil
}

func (s *Server) AIApply(ctx context.Context, req *taskv1.AIApplyRequest) (*taskv1.AIApplyResponse, error) {
	created, err := s.aiApply.Execute(ctx, usecase.AIApplyInput{
		TaskID:    req.GetTaskId(),
		Proposals: toDomainSubtaskProposals(req.GetProposals()),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	out := make([]*taskv1.Task, 0, len(created))
	for _, t := range created {
		out = append(out, toProtoTask(t))
	}
	return &taskv1.AIApplyResponse{CreatedSubtasks: out}, nil
}

func toProtoSubtaskProposals(proposals []domain.SubtaskProposal) []*taskv1.SubtaskProposal {
	out := make([]*taskv1.SubtaskProposal, 0, len(proposals))
	for _, p := range proposals {
		out = append(out, &taskv1.SubtaskProposal{Title: p.Title, Description: p.Description})
	}
	return out
}

func toDomainSubtaskProposals(proposals []*taskv1.SubtaskProposal) []domain.SubtaskProposal {
	out := make([]domain.SubtaskProposal, 0, len(proposals))
	for _, p := range proposals {
		out = append(out, domain.SubtaskProposal{Title: p.GetTitle(), Description: p.GetDescription()})
	}
	return out
}

func toDomainEdgeKind(t taskv1.EdgeType) domain.EdgeKind {
	switch t {
	case taskv1.EdgeType_EDGE_TYPE_PARENT_CHILD:
		return domain.EdgeKindParentChild
	case taskv1.EdgeType_EDGE_TYPE_DEPENDS_ON:
		return domain.EdgeKindDependsOn
	default:
		return ""
	}
}

func toDomainGrantLevel(l taskv1.GrantLevel) domain.GrantLevel {
	switch l {
	case taskv1.GrantLevel_GRANT_LEVEL_OWNER:
		return domain.GrantLevelOwner
	case taskv1.GrantLevel_GRANT_LEVEL_ADMIN:
		return domain.GrantLevelAdmin
	case taskv1.GrantLevel_GRANT_LEVEL_USER:
		return domain.GrantLevelUser
	case taskv1.GrantLevel_GRANT_LEVEL_TEAM:
		return domain.GrantLevelTeam
	case taskv1.GrantLevel_GRANT_LEVEL_COMPANY:
		return domain.GrantLevelCompany
	default:
		return domain.GrantLevelUnspecified
	}
}

func toProtoGrantLevel(l domain.GrantLevel) taskv1.GrantLevel {
	switch l {
	case domain.GrantLevelOwner:
		return taskv1.GrantLevel_GRANT_LEVEL_OWNER
	case domain.GrantLevelAdmin:
		return taskv1.GrantLevel_GRANT_LEVEL_ADMIN
	case domain.GrantLevelUser:
		return taskv1.GrantLevel_GRANT_LEVEL_USER
	case domain.GrantLevelTeam:
		return taskv1.GrantLevel_GRANT_LEVEL_TEAM
	case domain.GrantLevelCompany:
		return taskv1.GrantLevel_GRANT_LEVEL_COMPANY
	default:
		return taskv1.GrantLevel_GRANT_LEVEL_UNSPECIFIED
	}
}

func toProtoTask(t domain.Task) *taskv1.Task {
	return &taskv1.Task{
		Id:                 t.ID,
		TenantId:           t.TenantID,
		Title:              t.Title,
		Status:             t.Status,
		ParentId:           t.ParentID,
		ProjectId:          t.ProjectID,
		WorkflowTemplateId: t.WorkflowTemplateID,
	}
}
