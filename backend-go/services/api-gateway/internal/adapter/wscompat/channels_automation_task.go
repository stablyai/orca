// registerAutomationTaskChannels wires the automation.*/task.* channels
// added by TASK-217/TASK-219/TASK-222/TASK-225 (specs/backend-go/bugs/missing-v1).
//
// Kept in its own file rather than folded into channels.go's
// registerAutomationChannels/registerTaskChannels: a separate agent edits
// git-gateway-service's wscompat channels concurrently in the same
// worktree, and both agents adding registrations to the same function in
// channels.go would create unmergeable conflicts. This file's
// registerAutomationTaskChannels must be called once from RegisterRealChannels
// (channels.go) alongside the existing registerAutomationChannels/
// registerTaskChannels calls — see this package's integration-pass note in
// the task specs for the exact one-line wiring still needed there and in
// api-gateway's cmd/server/main.go composition root.
//
// automation.* channel coverage after this file: runNow (registered in
// channels.go's registerAutomationChannels) plus create/runs (TASK-217) and
// list/update/delete (TASK-219) here — all 6 methods.
//
// task.* channel coverage after this file: create/get (registered in
// channels.go's registerTaskChannels — kept per TASK-222's doc note despite
// BUG-034's dead-code finding: CreateTask/GetTask back real usecases this
// package's own list/update/delete/getDependencies reuse via Get, and
// removing working code over an unconfirmed frontend-call-site audit is the
// riskier move) plus execute (TASK-222) and
// list/update/delete/getDependencies/aiDecompose/aiApply (TASK-223/224/225)
// here — all 7 of the frontend's real task.* methods, plus the 2
// kept-but-unconfirmed create/get. ComplexExecutor (task.execute's complex
// branch) remains a stub — not part of this pass's scope, see TASK-224.
package wscompat

import (
	"context"
	"encoding/json"
	"strings"

	"google.golang.org/protobuf/types/known/wrapperspb"

	automationv1 "github.com/stablyai/orca-go/proto/gen/go/orca/automation/v1"
	taskv1 "github.com/stablyai/orca-go/proto/gen/go/orca/task/v1"
	workflowv1 "github.com/stablyai/orca-go/proto/gen/go/orca/workflow/v1"
)

// parseStepType mirrors httpgateway's parseStepType (automation_routes.go)
// — duplicated rather than imported since wscompat has no existing
// dependency on httpgateway and this is a single small switch. Keep the
// two in sync if workflowv1.StepType grows a new value. Also reused by
// task.* channels below since AI-decompose proposals and automation step
// configs share the same StepType enum.
func parseStepType(v string) workflowv1.StepType {
	name := strings.ToUpper(v)
	if !strings.HasPrefix(name, "STEP_TYPE_") {
		name = "STEP_TYPE_" + name
	}
	if n, ok := workflowv1.StepType_value[name]; ok {
		return workflowv1.StepType(n)
	}
	return workflowv1.StepType_STEP_TYPE_UNSPECIFIED
}

// registerAutomationTaskChannels registers every automation.*/task.*
// channel this scope (TASK-217/219/222/225) adds. See this file's package
// doc comment for the wiring call site this still needs in channels.go and
// main.go.
func registerAutomationTaskChannels(r *Registry, automationClient automationv1.AutomationServiceClient, taskClient taskv1.TaskServiceClient) {
	registerAutomationCRUDChannels(r, automationClient)
	registerTaskCRUDChannels(r, taskClient)
}

// automationRunsListView/automationsListView are plain (non-proto.Message)
// mirrors of ListRunsResponse/ListAutomationsResponse — see the automation.
// runs/automation.list handlers below for why returning the proto response
// directly would silently reach the caller as JSON `null` for an empty list.
type automationRunsListView struct {
	Runs          []*automationv1.AutomationRun `json:"runs"`
	NextPageToken string                        `json:"nextPageToken"`
}

type automationsListView struct {
	Automations   []*automationv1.Automation `json:"automations"`
	NextPageToken string                     `json:"nextPageToken"`
}

// ── automation.create / automation.runs (TASK-217) and
// automation.list/update/delete (TASK-219) ──────────────────────────────

func registerAutomationCRUDChannels(r *Registry, client automationv1.AutomationServiceClient) {
	r.Register("automation.create", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type createArgs struct {
			Name           string `json:"name"`
			RRule          string `json:"rrule"`
			StepConfigJSON string `json:"stepConfigJson"`
			StepType       string `json:"stepType"`
			Dtstart        string `json:"dtstart"`
			Timezone       string `json:"timezone"`
		}
		in, err := decodeArg[createArgs](args, 0)
		if err != nil {
			return nil, err
		}
		// id.TenantID (the validated Identity), never a client-supplied
		// tenant id from args — same posture httpgateway's
		// createAutomationRequestBody already follows.
		resp, err := client.CreateAutomation(ctx, &automationv1.CreateAutomationRequest{
			TenantId: id.TenantID, Name: in.Name, Rrule: in.RRule,
			StepConfigJson: in.StepConfigJSON, StepType: parseStepType(in.StepType),
			Dtstart: in.Dtstart, Timezone: in.Timezone,
		})
		if err != nil {
			return nil, err
		}
		return resp.GetAutomation(), nil
	})

	r.Register("automation.runs", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type runsArgs struct {
			AutomationID string `json:"automationId"`
			PageToken    string `json:"pageToken"`
			PageSize     int32  `json:"pageSize"`
		}
		in, err := decodeArg[runsArgs](args, 0)
		if err != nil {
			return nil, err
		}
		resp, err := client.ListRuns(ctx, &automationv1.ListRunsRequest{
			AutomationId: in.AutomationID, PageToken: in.PageToken, PageSize: in.PageSize,
		})
		if err != nil {
			return nil, err
		}
		// Why: returning resp directly would skip Dispatch's normalizeNilSlices
		// guard (specs/backend-go/bugs/missing-v2/BUG-005) — resp implements
		// proto.Message, which that normalizer deliberately never reaches
		// into, so a zero-runs response's `Runs` field would stay the nil
		// slice proto3's generated getter returns, serializing as JSON `null`
		// instead of `[]` (live-reproduced on the Automation page's initial,
		// no-automation-selected "all runs" load).
		return automationRunsListView{Runs: resp.GetRuns(), NextPageToken: resp.GetNextPageToken()}, nil
	})

	r.Register("automation.list", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type listArgs struct {
			PageToken string `json:"pageToken"`
			PageSize  int32  `json:"pageSize"`
		}
		in, err := decodeArg[listArgs](args, 0)
		if err != nil {
			return nil, err
		}
		resp, err := client.ListAutomations(ctx, &automationv1.ListAutomationsRequest{
			TenantId: id.TenantID, PageToken: in.PageToken, PageSize: in.PageSize,
		})
		if err != nil {
			return nil, err
		}
		// Why: same BUG-005 gap as automation.runs above — resp implements
		// proto.Message, so Dispatch's normalizeNilSlices skips it entirely.
		return automationsListView{Automations: resp.GetAutomations(), NextPageToken: resp.GetNextPageToken()}, nil
	})

	r.Register("automation.update", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type updateArgs struct {
			ID             string  `json:"id"`
			Name           *string `json:"name"`
			RRule          *string `json:"rrule"`
			StepConfigJSON *string `json:"stepConfigJson"`
			StepType       *string `json:"stepType"`
			Enabled        *bool   `json:"enabled"`
			Dtstart        *string `json:"dtstart"`
			Timezone       *string `json:"timezone"`
		}
		in, err := decodeArg[updateArgs](args, 0)
		if err != nil {
			return nil, err
		}
		req := &automationv1.UpdateAutomationRequest{Id: in.ID, TenantId: id.TenantID}
		if in.Name != nil {
			req.Name = wrapperspb.String(*in.Name)
		}
		if in.RRule != nil {
			req.Rrule = wrapperspb.String(*in.RRule)
		}
		if in.StepConfigJSON != nil {
			req.StepConfigJson = wrapperspb.String(*in.StepConfigJSON)
		}
		if in.StepType != nil {
			req.StepType = parseStepType(*in.StepType)
		}
		if in.Enabled != nil {
			req.Enabled = wrapperspb.Bool(*in.Enabled)
		}
		if in.Dtstart != nil {
			req.Dtstart = wrapperspb.String(*in.Dtstart)
		}
		if in.Timezone != nil {
			req.Timezone = wrapperspb.String(*in.Timezone)
		}
		resp, err := client.UpdateAutomation(ctx, req)
		if err != nil {
			return nil, err
		}
		return resp.GetAutomation(), nil
	})

	r.Register("automation.delete", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type deleteArgs struct {
			ID string `json:"id"`
		}
		in, err := decodeArg[deleteArgs](args, 0)
		if err != nil {
			return nil, err
		}
		if _, err := client.DeleteAutomation(ctx, &automationv1.DeleteAutomationRequest{Id: in.ID, TenantId: id.TenantID}); err != nil {
			return nil, err
		}
		return map[string]bool{"success": true}, nil
	})
}

// ── task.execute (TASK-222) and
// task.list/update/delete/getDependencies/aiDecompose/aiApply (TASK-225) ──

func registerTaskCRUDChannels(r *Registry, client taskv1.TaskServiceClient) {
	r.Register("task.execute", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type executeArgs struct {
			TaskID    string `json:"taskId"`
			RequestID string `json:"requestId"`
			// Prompt: TaskPromptEditor.tsx's user-edited override — see
			// TaskServiceExecuteRequest.prompt's own doc comment
			// (docs/backlog/BACKLOG-016). Empty = executor's own default.
			Prompt string `json:"prompt"`
		}
		in, err := decodeArg[executeArgs](args, 0)
		if err != nil {
			return nil, err
		}
		resp, err := client.Execute(ctx, &taskv1.TaskServiceExecuteRequest{TaskId: in.TaskID, RequestId: in.RequestID, Prompt: in.Prompt})
		if err != nil {
			return nil, err
		}
		return resp, nil
	})

	r.Register("task.list", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type listArgs struct {
			ProjectID string `json:"projectId"`
			PageToken string `json:"pageToken"`
			PageSize  int32  `json:"pageSize"`
		}
		in, err := decodeArg[listArgs](args, 0)
		if err != nil {
			return nil, err
		}
		resp, err := client.ListTasks(ctx, &taskv1.ListTasksRequest{
			ProjectId: in.ProjectID, PageToken: in.PageToken, PageSize: in.PageSize,
		})
		if err != nil {
			return nil, err
		}
		return resp, nil
	})

	r.Register("task.update", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type updateArgs struct {
			ID                 string  `json:"id"`
			Title              *string `json:"title"`
			Status             *string `json:"status"`
			WorkflowTemplateID *string `json:"workflowTemplateId"`
		}
		in, err := decodeArg[updateArgs](args, 0)
		if err != nil {
			return nil, err
		}
		req := &taskv1.UpdateTaskRequest{Id: in.ID}
		if in.Title != nil {
			req.Title = wrapperspb.String(*in.Title)
		}
		if in.Status != nil {
			req.Status = wrapperspb.String(*in.Status)
		}
		if in.WorkflowTemplateID != nil {
			req.WorkflowTemplateId = wrapperspb.String(*in.WorkflowTemplateID)
		}
		resp, err := client.UpdateTask(ctx, req)
		if err != nil {
			return nil, err
		}
		return resp.GetTask(), nil
	})

	r.Register("task.delete", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type deleteArgs struct {
			ID string `json:"id"`
		}
		in, err := decodeArg[deleteArgs](args, 0)
		if err != nil {
			return nil, err
		}
		if _, err := client.DeleteTask(ctx, &taskv1.DeleteTaskRequest{Id: in.ID}); err != nil {
			return nil, err
		}
		return map[string]bool{"success": true}, nil
	})

	r.Register("task.getDependencies", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type depsArgs struct {
			TaskID string `json:"taskId"`
		}
		in, err := decodeArg[depsArgs](args, 0)
		if err != nil {
			return nil, err
		}
		resp, err := client.GetDependencies(ctx, &taskv1.GetDependenciesRequest{TaskId: in.TaskID})
		if err != nil {
			return nil, err
		}
		return resp.GetDependencies(), nil
	})

	r.Register("task.aiDecompose", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type decomposeArgs struct {
			TaskID string `json:"taskId"`
		}
		in, err := decodeArg[decomposeArgs](args, 0)
		if err != nil {
			return nil, err
		}
		resp, err := client.AIDecompose(ctx, &taskv1.AIDecomposeRequest{TaskId: in.TaskID})
		if err != nil {
			return nil, err
		}
		return resp.GetProposals(), nil
	})

	r.Register("task.aiApply", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type applyArgs struct {
			TaskID    string                    `json:"taskId"`
			Proposals []*taskv1.SubtaskProposal `json:"proposals"`
		}
		in, err := decodeArg[applyArgs](args, 0)
		if err != nil {
			return nil, err
		}
		resp, err := client.AIApply(ctx, &taskv1.AIApplyRequest{TaskId: in.TaskID, Proposals: in.Proposals})
		if err != nil {
			return nil, err
		}
		return resp.GetCreatedSubtasks(), nil
	})
}
