package grpcclient

import (
	"context"
	"fmt"
)

// StubComplexExecutor implements usecase.ComplexExecutor as a stub that
// returns a synthesized execution reference without calling
// orchestration-service. Real wiring needs: an
// orchestrationv1.OrchestrationServiceClient (gRPC) dialed to
// orchestration-service, handing off to its coordinator (task-service.md
// §3.1), which sequences subtask/dependency execution and itself reaches
// the Dev Server Agent for worker dispatch. orchestration-service calls
// back into task-service to read/update task state as it progresses — that
// inbound path is this service's gRPC server (internal/adapter/grpc), not
// this client.
type StubComplexExecutor struct{}

func NewStubComplexExecutor() *StubComplexExecutor {
	return &StubComplexExecutor{}
}

func (s *StubComplexExecutor) Execute(ctx context.Context, tenantID, taskID, requestID, prompt string) (string, error) {
	return fmt.Sprintf("stub-orchestration-exec:%s:%s", taskID, requestID), nil
}
