package httpgateway

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"

	gatewaygrpc "github.com/stablyai/orca-go/services/api-gateway/internal/adapter/grpc"

	orchestrationv1 "github.com/stablyai/orca-go/proto/gen/go/orca/orchestration/v1"
)

// mountOrchestrationRoutes wires REST->gRPC reverse-proxy routes for
// orchestration-service, following the same hand-written translation
// pattern as mountUsageRoutes (see usage_routes.go's doc comment):
// tenant_id/user_id always come from identityFromContext, never the
// request body, per api-gateway.md §9.
func mountOrchestrationRoutes(r chi.Router, client orchestrationv1.OrchestrationServiceClient) {
	r.Route("/v1/orchestration", func(sub chi.Router) {
		sub.Post("/dispatch-contexts", handleCreateDispatchContext(client))
		sub.Post("/gates", handleCreateGate(client))
		sub.Post("/gates/{id}/resolve", handleResolveGate(client))
		sub.Put("/tasks/{id}/status", handleUpdateTaskStatusAndPromote(client))
	})
}

// createDispatchContextRequestBody is the REST request shape for POST
// /v1/orchestration/dispatch-contexts.
type createDispatchContextRequestBody struct {
	Handle              string `json:"handle"`
	CoordinatorRunID    string `json:"coordinator_run_id"`
	OrchestrationTaskID string `json:"orchestration_task_id"`
	WorktreeID          string `json:"worktree_id"`
}

func handleCreateDispatchContext(client orchestrationv1.OrchestrationServiceClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		identity, _ := identityFromContext(r.Context())

		var body createDispatchContextRequestBody
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSONError(w, http.StatusBadRequest, "INVALID_ARGUMENT", "invalid JSON body: "+err.Error())
			return
		}

		ctx := gatewaygrpc.AttachIdentity(r.Context(), identity)
		resp, err := client.CreateDispatchContext(ctx, &orchestrationv1.CreateDispatchContextRequest{
			Handle:              body.Handle,
			CoordinatorRunId:    body.CoordinatorRunID,
			OrchestrationTaskId: body.OrchestrationTaskID,
			WorktreeId:          body.WorktreeID,
		})
		if err != nil {
			writeGRPCError(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, resp.GetContext())
	}
}

// createGateRequestBody is the REST request shape for POST
// /v1/orchestration/gates.
type createGateRequestBody struct {
	DispatchContextID   string   `json:"dispatch_context_id"`
	OrchestrationTaskID string   `json:"orchestration_task_id"`
	Question            string   `json:"question"`
	Options             []string `json:"options"`
}

func handleCreateGate(client orchestrationv1.OrchestrationServiceClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		identity, _ := identityFromContext(r.Context())

		var body createGateRequestBody
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSONError(w, http.StatusBadRequest, "INVALID_ARGUMENT", "invalid JSON body: "+err.Error())
			return
		}
		if body.DispatchContextID == "" {
			writeJSONError(w, http.StatusBadRequest, "INVALID_ARGUMENT", "dispatch_context_id is required")
			return
		}

		ctx := gatewaygrpc.AttachIdentity(r.Context(), identity)
		resp, err := client.CreateGate(ctx, &orchestrationv1.CreateGateRequest{
			DispatchContextId:   body.DispatchContextID,
			OrchestrationTaskId: body.OrchestrationTaskID,
			Question:            body.Question,
			Options:             body.Options,
		})
		if err != nil {
			writeGRPCError(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, resp.GetGate())
	}
}

// resolveGateRequestBody is the REST request shape for POST
// /v1/orchestration/gates/{id}/resolve. gate_id comes from the path, not
// the body.
type resolveGateRequestBody struct {
	OutcomeJSON string `json:"outcome_json"`
}

func handleResolveGate(client orchestrationv1.OrchestrationServiceClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		identity, _ := identityFromContext(r.Context())
		gateID := chi.URLParam(r, "id")

		var body resolveGateRequestBody
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSONError(w, http.StatusBadRequest, "INVALID_ARGUMENT", "invalid JSON body: "+err.Error())
			return
		}

		ctx := gatewaygrpc.AttachIdentity(r.Context(), identity)
		resp, err := client.ResolveGate(ctx, &orchestrationv1.ResolveGateRequest{
			GateId:      gateID,
			OutcomeJson: body.OutcomeJSON,
		})
		if err != nil {
			writeGRPCError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, resp.GetGate())
	}
}

// updateTaskStatusRequestBody is the REST request shape for PUT
// /v1/orchestration/tasks/{id}/status. orchestration_task_id comes from
// the path, not the body.
type updateTaskStatusRequestBody struct {
	NewStatus string `json:"new_status"`
}

func handleUpdateTaskStatusAndPromote(client orchestrationv1.OrchestrationServiceClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		identity, _ := identityFromContext(r.Context())
		taskID := chi.URLParam(r, "id")

		var body updateTaskStatusRequestBody
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSONError(w, http.StatusBadRequest, "INVALID_ARGUMENT", "invalid JSON body: "+err.Error())
			return
		}
		if body.NewStatus == "" {
			writeJSONError(w, http.StatusBadRequest, "INVALID_ARGUMENT", "new_status is required")
			return
		}

		ctx := gatewaygrpc.AttachIdentity(r.Context(), identity)
		resp, err := client.UpdateTaskStatusAndPromote(ctx, &orchestrationv1.UpdateTaskStatusAndPromoteRequest{
			OrchestrationTaskId: taskID,
			NewStatus:           body.NewStatus,
		})
		if err != nil {
			writeGRPCError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, resp)
	}
}
