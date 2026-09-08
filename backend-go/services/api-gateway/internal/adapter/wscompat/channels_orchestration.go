package wscompat

import (
	"context"
	"encoding/json"

	orchestrationv1 "github.com/stablyai/orca-go/proto/gen/go/orca/orchestration/v1"
)

// dispatchView is the wire shape orchestration.dispatchShow returns —
// assignee_handle here is DispatchContext.handle under the name
// terminal-orchestration-task-links.ts actually reads. SOL-018 resolves
// this as a wire-naming gap, not a missing field — the translation
// happens here at the wscompat boundary rather than as a proto rename
// (DispatchContext.handle is used by 3 existing RPCs + 2 REST handlers).
type dispatchView struct {
	ID                  string `json:"id"`
	OrchestrationTaskID string `json:"orchestration_task_id"`
	AssigneeHandle      string `json:"assignee_handle"`
	Status              string `json:"status"`
}

func registerOrchestrationChannels(r *Registry, client orchestrationv1.OrchestrationServiceClient) {
	r.Register("orchestration.dispatchShow", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type dispatchShowArgs struct {
			Task string `json:"task"`
		}
		in, err := decodeArg[dispatchShowArgs](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = attachIdentity(ctx, id)
		rpcCtx, cancel := context.WithTimeout(ctx, groupRPCTimeout)
		defer cancel()
		resp, err := client.GetDispatchContextForTask(rpcCtx, &orchestrationv1.GetDispatchContextForTaskRequest{
			OrchestrationTaskId: in.Task,
		})
		if err != nil {
			return nil, err
		}
		dc := resp.GetDispatch()
		if dc == nil {
			// No dispatch yet — matches focusRuntimeOrchestrationTask's own
			// null-safe `result.dispatch?.assignee_handle` read and its
			// client-side "No dispatched terminal for orchestration task"
			// error when absent.
			return map[string]any{"dispatch": nil}, nil
		}
		return map[string]any{"dispatch": dispatchView{
			ID:                  dc.GetId(),
			OrchestrationTaskID: dc.GetOrchestrationTaskId(),
			AssigneeHandle:      dc.GetHandle(),
			// DispatchContext.status now exists for real (added alongside
			// ListActiveDispatchContextsForUser, CR-STORAGE-006/007) —
			// the "no status field yet" gap this comment used to flag is
			// closed.
			Status: dc.GetStatus(),
		}}, nil
	})

	// agentSession.listActive: every active dispatch context for the
	// calling user (identity, never a request field) — CR-STORAGE-006/007's
	// hydrate for "which of my AI-agent sessions are currently running."
	// See docs/backlog/BACKLOG-006-dispatch-context-user-linkage-decision.md
	// for why this filters DispatchContext.user_id directly rather than
	// resolving through a coordinator_run (no RPC creates one yet).
	r.Register("agentSession.listActive", func(ctx context.Context, id Identity, _ []json.RawMessage) (any, error) {
		ctx = attachIdentity(ctx, id)
		rpcCtx, cancel := context.WithTimeout(ctx, groupRPCTimeout)
		defer cancel()
		resp, err := client.ListActiveDispatchContextsForUser(rpcCtx, &orchestrationv1.ListActiveDispatchContextsForUserRequest{})
		if err != nil {
			return nil, err
		}
		views := make([]agentSessionView, 0, len(resp.GetDispatchContexts()))
		for _, dc := range resp.GetDispatchContexts() {
			views = append(views, agentSessionView{
				ID:                  dc.GetId(),
				OrchestrationTaskID: dc.GetOrchestrationTaskId(),
				AssigneeHandle:      dc.GetHandle(),
				Status:              dc.GetStatus(),
				FailureCount:        dc.GetFailureCount(),
				LastHeartbeatAt:     dc.GetLastHeartbeatAt(),
			})
		}
		return map[string]any{"agentSessions": views}, nil
	})
}

// agentSessionView is agentSession.listActive's wire shape — camelCase,
// explicit struct rather than the raw proto message (per BE-SOL-001's
// documented finding: protoc-gen-go's plain encoding/json struct tags are
// snake_case, and this wscompat envelope serializes via plain
// encoding/json, not protojson).
type agentSessionView struct {
	ID                  string `json:"id"`
	OrchestrationTaskID string `json:"orchestrationTaskId"`
	AssigneeHandle      string `json:"assigneeHandle"`
	Status              string `json:"status"`
	FailureCount        int32  `json:"failureCount"`
	LastHeartbeatAt     string `json:"lastHeartbeatAt"` // RFC3339; "" if never heartbeated
}
