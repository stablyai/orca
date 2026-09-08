# TASK-TASKV1-005-09: `grpc/server.go` — 6 new handlers; `cmd/server/main.go` — dial `infra-fleet-service`/`task-service`, wire lifecycle usecases

**From Solution:** SOL-TASKV1-005
**Priority:** P1
**Service:** `orchestration-service` (`internal/adapter/grpc`, `cmd/server`)
**File:** `backend-go/services/orchestration-service/internal/adapter/grpc/server.go`, `backend-go/services/orchestration-service/cmd/server/main.go`, `backend-go/services/orchestration-service/internal/config/config.go`
**Depends on:** TASK-TASKV1-005-02 (proto), TASK-TASKV1-005-06 (usecases), TASK-TASKV1-005-07 (`UpdateTaskStatusAndPromote` new constructor signature), TASK-TASKV1-005-08 (adapters)
**Status:** `[ ]` TODO

---

## Context

`server.go` (185 lines, read in full) implements
`orchestrationv1.UnimplementedOrchestrationServiceServer` for the existing
7 RPCs via a `Server` struct holding one usecase pointer per method. This
task adds 6 more fields/handlers following that exact pattern, plus a
shared `toProtoCoordinatorRun` mapper (mirroring the existing
`toProtoDispatchContext` helper, `server.go:83-99`). `main.go` (147 lines,
read in full) today only dials Postgres — this task adds two more `Dial`
calls (`infra-fleet-service`, `task-service`), following `task-service`'s
own `cmd/server/main.go:89-99` dial pattern exactly (`grpcclient.Dial`,
deferred `Close()`, construct the generated client, pass it into the new
adapter's constructor).

## Changes to make

### `internal/config/config.go`

`Config` today is bare `commonconfig.Base` (no per-service addr fields) —
add the two new downstream addresses, following `task-service`'s
`InfraFleetServiceAddr`/`AIProviderServiceAddr` config pattern
(`services/task-service/internal/config/config.go:20-38`):

```go
type Config struct {
	commonconfig.Base
	// InfraFleetServiceAddr is where WorkerDispatcher dials
	// infra-fleet-service's Relay RPC (TASK-TASKV1-005-08).
	InfraFleetServiceAddr string
	// TaskServiceAddr is where TaskServiceReporter dials task-service's
	// ReportTaskExecutionResult RPC (TASK-TASKV1-005-08).
	TaskServiceAddr string
}

func Load() (Config, error) {
	base, err := commonconfig.LoadBase("orchestration-service")
	if err != nil {
		return Config{}, err
	}
	return Config{
		Base:                  base,
		InfraFleetServiceAddr: commonconfig.StringEnv("INFRA_FLEET_SERVICE_ADDR", "infra-fleet-service:9090"),
		TaskServiceAddr:       commonconfig.StringEnv("TASK_SERVICE_ADDR", "task-service:9090"),
	}, nil
}
```

### `internal/adapter/grpc/server.go`

Add 6 new fields to `Server` and constructor parameters to `New` (after the
existing `failDispatch` field/param):

```go
type Server struct {
	orchestrationv1.UnimplementedOrchestrationServiceServer

	createDispatchContext             *usecase.CreateDispatchContext
	createGate                        *usecase.CreateGate
	resolveGate                       *usecase.ResolveGate
	updateTaskStatusAndPromote        *usecase.UpdateTaskStatusAndPromote
	getDispatchContextForTask         *usecase.GetDispatchContextForTask
	listActiveDispatchContextsForUser *usecase.ListActiveDispatchContextsForUser
	failDispatch                      *usecase.FailDispatch
	startCoordinatorRun               *usecase.StartCoordinatorRun
	getCoordinatorRun                 *usecase.GetCoordinatorRun
	completeCoordinatorRun            *usecase.CompleteCoordinatorRun
	failCoordinatorRun                *usecase.FailCoordinatorRun
	recordHeartbeat                   *usecase.RecordHeartbeat
	listPendingDecisionGates          *usecase.ListPendingDecisionGates
}
```

(constructor `New` widened symmetrically — omitted here, same
mechanical parameter-list + field-assignment pattern as the existing 7.)

Add the 6 handlers (after the existing `FailDispatch` handler, end of file):

```go
func toProtoCoordinatorRun(run domain.CoordinatorRun) *orchestrationv1.CoordinatorRun {
	return &orchestrationv1.CoordinatorRun{
		Id:                run.ID,
		OriginTaskId:      run.OriginTaskID,
		SpecJson:          string(run.Spec),
		Status:            string(run.Status),
		CoordinatorHandle: run.CoordinatorHandle,
		PollIntervalMs:    run.PollIntervalMs,
		WorktreeId:        run.WorktreeID,
		ResultJson:        string(run.Result),
		ErrorMessage:      run.ErrorMessage,
	}
}

func (s *Server) StartCoordinatorRun(ctx context.Context, req *orchestrationv1.StartCoordinatorRunRequest) (*orchestrationv1.CoordinatorRun, error) {
	run, err := s.startCoordinatorRun.Execute(ctx, usecase.StartCoordinatorRunInput{
		OriginTaskID: req.GetOriginTaskId(),
		SpecJSON:     json.RawMessage(req.GetSpecJson()),
		WorktreeID:   req.GetWorktreeId(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return toProtoCoordinatorRun(run), nil
}

func (s *Server) GetCoordinatorRun(ctx context.Context, req *orchestrationv1.GetCoordinatorRunRequest) (*orchestrationv1.CoordinatorRun, error) {
	run, err := s.getCoordinatorRun.Execute(ctx, req.GetId())
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return toProtoCoordinatorRun(run), nil
}

func (s *Server) CompleteCoordinatorRun(ctx context.Context, req *orchestrationv1.CompleteCoordinatorRunRequest) (*orchestrationv1.CoordinatorRun, error) {
	run, err := s.completeCoordinatorRun.Execute(ctx, usecase.CompleteCoordinatorRunInput{
		ID: req.GetId(), ResultJSON: json.RawMessage(req.GetResultJson()),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return toProtoCoordinatorRun(run), nil
}

func (s *Server) FailCoordinatorRun(ctx context.Context, req *orchestrationv1.FailCoordinatorRunRequest) (*orchestrationv1.CoordinatorRun, error) {
	run, err := s.failCoordinatorRun.Execute(ctx, usecase.FailCoordinatorRunInput{
		ID: req.GetId(), ErrorMessage: req.GetErrorMessage(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return toProtoCoordinatorRun(run), nil
}

func (s *Server) RecordHeartbeat(ctx context.Context, req *orchestrationv1.RecordHeartbeatRequest) (*orchestrationv1.DispatchContext, error) {
	dc, err := s.recordHeartbeat.Execute(ctx, req.GetDispatchContextId())
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return toProtoDispatchContext(dc), nil
}

func (s *Server) ListPendingDecisionGates(ctx context.Context, _ *orchestrationv1.ListPendingDecisionGatesRequest) (*orchestrationv1.ListPendingDecisionGatesResponse, error) {
	gates, err := s.listPendingDecisionGates.Execute(ctx)
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	out := make([]*orchestrationv1.DecisionGate, 0, len(gates))
	for _, g := range gates {
		out = append(out, &orchestrationv1.DecisionGate{
			Id: g.ID, DispatchContextId: g.DispatchContextID, Status: string(g.Status),
			Question: g.Question, Options: g.Options,
		})
	}
	return &orchestrationv1.ListPendingDecisionGatesResponse{Gates: out}, nil
}
```

Add `"encoding/json"` to this file's imports.

### `cmd/server/main.go`

After `repo := orchpostgres.New(pool)` and before `serializer :=
usecase.NewKeyedSerializer(0)`, dial the two new downstream services:

```go
infraFleetConn, err := grpcclient.Dial(cfg.InfraFleetServiceAddr)
if err != nil {
	return fmt.Errorf("dialing infra-fleet-service: %w", err)
}
defer func() { _ = infraFleetConn.Close() }()
infraFleetClient := infrafleetv1.NewInfraFleetServiceClient(infraFleetConn)
workerDispatcher := infrafleetclient.NewWorkerDispatcher(infraFleetClient)

taskServiceConn, err := grpcclient.Dial(cfg.TaskServiceAddr)
if err != nil {
	return fmt.Errorf("dialing task-service: %w", err)
}
defer func() { _ = taskServiceConn.Close() }()
taskServiceClient := taskv1.NewTaskServiceClient(taskServiceConn)
taskServiceReporter := taskserviceclient.NewReporter(taskServiceClient)
```

`grpcclient.Dial` does not exist in `orchestration-service` yet — add a
`backend-go/services/orchestration-service/internal/adapter/grpcclient/dial.go`
that is a byte-for-byte copy of `task-service`'s
`internal/adapter/grpcclient/dial.go` (lazy-dial, insecure transport
credentials, same doc comment referencing this file as the shared
convention) — this service currently has no generic outbound-dial helper
package (only `infrafleetclient`/`taskserviceclient`, both new in
`TASK-TASKV1-005-08`), so this task creates the shared `Dial` function
those two packages' `main.go` call sites need, rather than duplicating a
`grpc.NewClient` call inline for each.

Update the usecase-construction block:

```go
updateTaskStatusAndPromoteUC := usecase.NewUpdateTaskStatusAndPromote(repo, serializer, taskServiceReporter, repo)
startCoordinatorRunUC := usecase.NewStartCoordinatorRun(repo, serializer)
getCoordinatorRunUC := usecase.NewGetCoordinatorRun(repo)
completeCoordinatorRunUC := usecase.NewCompleteCoordinatorRun(repo, serializer)
failCoordinatorRunUC := usecase.NewFailCoordinatorRun(repo, serializer)
recordHeartbeatUC := usecase.NewRecordHeartbeat(repo)
listPendingDecisionGatesUC := usecase.NewListPendingDecisionGates(repo)
```

(`repo` here satisfies `CoordinatorRunRepository` as of `TASK-TASKV1-005-05`,
same single-concrete-`*Repository`-implements-every-port convention this
file already uses for `OrchestrationTaskRepository`/`DispatchContextRepository`/
`GateRepository`.)

Update the `orchgrpc.New(...)` call site to pass all 13 usecases in the
widened parameter order `server.go`'s `New` now declares.

Add the new imports: `infrafleetv1
"github.com/stablyai/orca-go/proto/gen/go/orca/infrafleet/v1"`, `taskv1
"github.com/stablyai/orca-go/proto/gen/go/orca/task/v1"`,
`"github.com/stablyai/orca-go/services/orchestration-service/internal/adapter/grpcclient"`,
`"github.com/stablyai/orca-go/services/orchestration-service/internal/adapter/infrafleetclient"`,
`"github.com/stablyai/orca-go/services/orchestration-service/internal/adapter/taskserviceclient"`.

## Verify

```bash
cd /opt/repos/orca/backend-go
go build ./services/orchestration-service/...
go vet ./services/orchestration-service/...
```

Expected: builds cleanly PROVIDED `TASK-TG-04-05`'s
`ReportTaskExecutionResult` RPC has landed in `taskv1` (this task's own
flagged dependency, inherited from `TASK-TASKV1-005-08`'s
`taskserviceclient.Reporter`) — if it has not, `go build` fails only inside
`taskserviceclient`/this file's `taskv1.NewTaskServiceClient` reference,
not the rest of the service; confirm which side is blocking before
treating a build failure here as a bug in this task's own code.

`internal/adapter/grpc/` has no test file at all today (confirmed: `ls`
shows only `server.go`) — this task is not expected to add one either
(the existing 7 handlers ship with none, and this task follows that
existing convention rather than introducing new coverage scope). Handler
correctness for the new RPCs is exercised indirectly by
`TASK-TASKV1-005-10`'s integration-level test, which drives
`StartCoordinatorRun` through a real (test-container) gRPC server.
