// Package grpcclient implements automation-service's outbound gRPC clients
// — the ports usecase/ needs to reach other services. workflow_client.go is
// the important one: a REAL gRPC client against workflow-service's
// ExecuteAdHocStep RPC, not a stub, since closing the "no execution path"
// gap by actually calling it is this service's entire reason for existing —
// see specs/backend-go/services/automation-service.md §2/§6.
package grpcclient

import (
	"context"
	"fmt"

	"google.golang.org/grpc"

	"github.com/stablyai/orca-go/services/automation-service/internal/domain"
	"github.com/stablyai/orca-go/services/automation-service/internal/usecase"

	workflowv1 "github.com/stablyai/orca-go/proto/gen/go/orca/workflow/v1"
)

// WorkflowClient implements usecase.WorkflowStepExecutor by calling
// workflow-service's generated WorkflowServiceClient over a real
// *grpc.ClientConn — see cmd/server/main.go for where that connection is
// dialed.
type WorkflowClient struct {
	client workflowv1.WorkflowServiceClient
}

// New wraps an already-dialed connection to workflow-service. Dialing
// itself happens once in cmd/server/main.go (the composition root), so this
// adapter stays a thin, easily-fakeable wrapper around the generated
// client — internal/usecase's tests fake usecase.WorkflowStepExecutor
// directly rather than needing a real workflow-service running.
func New(conn grpc.ClientConnInterface) *WorkflowClient {
	return &WorkflowClient{client: workflowv1.NewWorkflowServiceClient(conn)}
}

// ExecuteAdHocStep calls workflow-service.ExecuteAdHocStep for real — the
// gRPC round trip that closes TS Gap 3 (automation.runNow previously had no
// working execution path).
func (c *WorkflowClient) ExecuteAdHocStep(ctx context.Context, in usecase.ExecuteAdHocStepInput) (usecase.ExecuteAdHocStepOutput, error) {
	ctx, err := withTenantMetadata(ctx)
	if err != nil {
		return usecase.ExecuteAdHocStepOutput{}, fmt.Errorf("grpcclient: workflow-service ExecuteAdHocStep: %w", err)
	}
	resp, err := c.client.ExecuteAdHocStep(ctx, &workflowv1.ExecuteAdHocStepRequest{
		TenantId:       in.TenantID,
		StepType:       toProtoStepType(in.StepType),
		StepConfigJson: in.StepConfigJSON,
		RequestId:      in.RequestID,
	})
	if err != nil {
		return usecase.ExecuteAdHocStepOutput{}, fmt.Errorf("grpcclient: workflow-service ExecuteAdHocStep: %w", err)
	}
	result := resp.GetResult()
	return usecase.ExecuteAdHocStepOutput{
		Status:     result.GetStatus(),
		OutputJSON: result.GetOutputJson(),
	}, nil
}

func toProtoStepType(s domain.StepType) workflowv1.StepType {
	switch s {
	case domain.StepTypeAgent:
		return workflowv1.StepType_STEP_TYPE_AGENT
	case domain.StepTypeShell:
		return workflowv1.StepType_STEP_TYPE_SHELL
	case domain.StepTypeNotification:
		return workflowv1.StepType_STEP_TYPE_NOTIFICATION
	case domain.StepTypeWebhook:
		return workflowv1.StepType_STEP_TYPE_WEBHOOK
	case domain.StepTypeCondition:
		return workflowv1.StepType_STEP_TYPE_CONDITION
	case domain.StepTypeCommitPush:
		return workflowv1.StepType_STEP_TYPE_COMMIT_PUSH
	default:
		return workflowv1.StepType_STEP_TYPE_UNSPECIFIED
	}
}
