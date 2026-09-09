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

// parseAutomationActionType mirrors parseStepType's convention for
// automationv1.AutomationActionType — used by automation.create/
// automation.update's actions[] decode below (CR-AUTO-002/TASK-BE-AUTO-002
// added the proto field; this wscompat bridge never got the matching wire
// support until FE-TASK-AUTO-002's investigation found the gap).
func parseAutomationActionType(v string) automationv1.AutomationActionType {
	name := strings.ToUpper(v)
	if !strings.HasPrefix(name, "AUTOMATION_ACTION_TYPE_") {
		name = "AUTOMATION_ACTION_TYPE_" + name
	}
	if n, ok := automationv1.AutomationActionType_value[name]; ok {
		return automationv1.AutomationActionType(n)
	}
	return automationv1.AutomationActionType_AUTOMATION_ACTION_TYPE_UNSPECIFIED
}

// automationActionArg is the wire shape automation.create/automation.update
// decode each actions[] entry into — field names mirror
// automationv1.AutomationAction's camelCase JSON names (id/type/configJson/
// continueOnFailure) so the frontend's AutomationAction type
// (frontend/src/shared/automations-types.ts) needs no field renaming to
// send one of these directly.
type automationActionArg struct {
	ID                string `json:"id"`
	Type              string `json:"type"`
	ConfigJSON        string `json:"configJson"`
	ContinueOnFailure bool   `json:"continueOnFailure"`
}

func toProtoAutomationActions(in []automationActionArg) []*automationv1.AutomationAction {
	if in == nil {
		return nil
	}
	out := make([]*automationv1.AutomationAction, len(in))
	for i, a := range in {
		out[i] = &automationv1.AutomationAction{
			Id: a.ID, Type: parseAutomationActionType(a.Type),
			ConfigJson: a.ConfigJSON, ContinueOnFailure: a.ContinueOnFailure,
		}
	}
	return out
}

// parseEdgeType mirrors parseStepType's convention for taskv1.EdgeType —
// see task.addEdge below.
func parseEdgeType(v string) taskv1.EdgeType {
	name := strings.ToUpper(v)
	if !strings.HasPrefix(name, "EDGE_TYPE_") {
		name = "EDGE_TYPE_" + name
	}
	if n, ok := taskv1.EdgeType_value[name]; ok {
		return taskv1.EdgeType(n)
	}
	return taskv1.EdgeType_EDGE_TYPE_UNSPECIFIED
}

// parseGrantLevel mirrors parseStepType's convention for taskv1.GrantLevel —
// see task.grant below.
func parseGrantLevel(v string) taskv1.GrantLevel {
	name := strings.ToUpper(v)
	if !strings.HasPrefix(name, "GRANT_LEVEL_") {
		name = "GRANT_LEVEL_" + name
	}
	if n, ok := taskv1.GrantLevel_value[name]; ok {
		return taskv1.GrantLevel(n)
	}
	return taskv1.GrantLevel_GRANT_LEVEL_UNSPECIFIED
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
			// Actions/MaxRunHistory/RunTimeoutSeconds — CR-AUTO-002/007. Actions
			// takes precedence over StepConfigJSON/StepType server-side
			// (CreateAutomation's own doc) — a caller building a 1-action
			// chain (FE-AUTO-SOL-002 §3's "map thành actions:[{...}]" plan)
			// need not also send legacy step fields.
			Actions           []automationActionArg `json:"actions"`
			MaxRunHistory     int32                 `json:"maxRunHistory"`
			RunTimeoutSeconds int32                 `json:"runTimeoutSeconds"`
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
			Actions:       toProtoAutomationActions(in.Actions),
			MaxRunHistory: in.MaxRunHistory, RunTimeoutSeconds: in.RunTimeoutSeconds,
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
			// Actions is a pointer-to-slice, not a plain slice — mirrors
			// UpdateAutomationRequest.ActionsSet's own nil-vs-empty
			// distinction (CR-AUTO-007's field-mask-shaped design): an
			// omitted "actions" key decodes to nil (leave the chain
			// untouched), while an explicit "actions":[] decodes to a
			// non-nil pointer to an empty slice (clear the chain) — the
			// same tri-state UpdateAutomation's usecase layer already
			// implements and tests for (nil preserved / non-nil-empty
			// clears / non-nil-populated replaces).
			Actions           *[]automationActionArg `json:"actions"`
			MaxRunHistory     *int32                 `json:"maxRunHistory"`
			RunTimeoutSeconds *int32                 `json:"runTimeoutSeconds"`
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
		if in.Actions != nil {
			req.ActionsSet = &automationv1.AutomationActionList{Actions: toProtoAutomationActions(*in.Actions)}
		}
		if in.MaxRunHistory != nil {
			req.MaxRunHistory = wrapperspb.Int32(*in.MaxRunHistory)
		}
		if in.RunTimeoutSeconds != nil {
			req.RunTimeoutSeconds = wrapperspb.Int32(*in.RunTimeoutSeconds)
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

	// BACKLOG-015: AddEdge/Grant/ResolvePermission already exist as real
	// proto/usecase RPCs (task-service.md) but were never registered here —
	// wiring only, same pattern as every other handler in this function.
	r.Register("task.addEdge", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type addEdgeArgs struct {
			FromTaskID string `json:"fromTaskId"`
			ToTaskID   string `json:"toTaskId"`
			// Type: "parent_child" | "depends_on" — parsed the same
			// STEP_TYPE_-prefix-and-uppercase way parseStepType above does,
			// against taskv1.EdgeType_value.
			Type string `json:"type"`
		}
		in, err := decodeArg[addEdgeArgs](args, 0)
		if err != nil {
			return nil, err
		}
		if _, err := client.AddEdge(ctx, &taskv1.AddEdgeRequest{
			FromTaskId: in.FromTaskID, ToTaskId: in.ToTaskID, Type: parseEdgeType(in.Type),
		}); err != nil {
			return nil, err
		}
		return map[string]bool{"success": true}, nil
	})

	r.Register("task.grant", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type grantArgs struct {
			TaskID    string `json:"taskId"`
			SubjectID string `json:"subjectId"`
			// Level: "owner" | "admin" | "user" | "team" | "company" —
			// parsed against taskv1.GrantLevel_value, same convention as
			// EdgeType above.
			Level     string `json:"level"`
			ApplyTree bool   `json:"applyTree"`
		}
		in, err := decodeArg[grantArgs](args, 0)
		if err != nil {
			return nil, err
		}
		if _, err := client.Grant(ctx, &taskv1.GrantRequest{
			TaskId: in.TaskID, SubjectId: in.SubjectID, Level: parseGrantLevel(in.Level), ApplyTree: in.ApplyTree,
		}); err != nil {
			return nil, err
		}
		return map[string]bool{"success": true}, nil
	})

	r.Register("task.resolvePermission", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type resolvePermArgs struct {
			TaskID string `json:"taskId"`
			UserID string `json:"userId"`
		}
		in, err := decodeArg[resolvePermArgs](args, 0)
		if err != nil {
			return nil, err
		}
		resp, err := client.ResolvePermission(ctx, &taskv1.ResolvePermissionRequest{TaskId: in.TaskID, UserId: in.UserID})
		if err != nil {
			return nil, err
		}
		return map[string]string{"effectiveLevel": strings.ToLower(strings.TrimPrefix(resp.GetEffectiveLevel().String(), "GRANT_LEVEL_"))}, nil
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
