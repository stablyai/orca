package httpgateway

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"google.golang.org/protobuf/types/known/wrapperspb"

	gatewaygrpc "github.com/stablyai/orca-go/services/api-gateway/internal/adapter/grpc"

	automationv1 "github.com/stablyai/orca-go/proto/gen/go/orca/automation/v1"
	workflowv1 "github.com/stablyai/orca-go/proto/gen/go/orca/workflow/v1"
)

// mountAutomationRoutes wires the real REST->gRPC reverse-proxy path for
// automation-service, following the same hand-written translation pattern
// as mountUsageRoutes (usage_routes.go) — no grpc-gateway codegen, see that
// file's doc comment for why.
func mountAutomationRoutes(r chi.Router, client automationv1.AutomationServiceClient) {
	r.Route("/v1/automations", func(sub chi.Router) {
		sub.Post("/", handleCreateAutomation(client))
		sub.Get("/", handleListAutomations(client))
		sub.Patch("/{id}", handleUpdateAutomation(client))
		sub.Delete("/{id}", handleDeleteAutomation(client))
		sub.Post("/{id}/run", handleRunNow(client))
		sub.Get("/{id}/runs", handleListRuns(client))
		sub.Post("/{id}/trigger", handleHandleExternalTrigger(client))
	})
}

// handleListAutomations mirrors handleCreateAutomation's identity handling
// (tenant_id comes from the validated Identity, never a query param) — see
// TASK-BE-AUTO-012.
func handleListAutomations(client automationv1.AutomationServiceClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		identity, _ := identityFromContext(r.Context())
		q := r.URL.Query()

		var pageSize int32
		if v := q.Get("page_size"); v != "" {
			n, err := strconv.ParseInt(v, 10, 32)
			if err != nil {
				writeJSONError(w, http.StatusBadRequest, "INVALID_ARGUMENT", "page_size must be an integer")
				return
			}
			pageSize = int32(n)
		}

		ctx := gatewaygrpc.AttachIdentity(r.Context(), identity)
		resp, err := client.ListAutomations(ctx, &automationv1.ListAutomationsRequest{
			TenantId:  identity.TenantID,
			PageToken: q.Get("page_token"),
			PageSize:  pageSize,
		})
		if err != nil {
			writeGRPCError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, resp)
	}
}

// updateAutomationRequestBody uses pointer fields (like
// UpdateAutomationRequest's proto3 wrapper types) so an absent JSON key
// means "no change" — distinct from an explicit `null`/empty string, which
// updateStringField below still treats as "clear this field" by design
// (matches UpdateAutomationRequest's own field doc comment: partial edit,
// not full-replace).
type updateAutomationRequestBody struct {
	Name           *string `json:"name"`
	RRule          *string `json:"rrule"`
	StepConfigJSON *string `json:"step_config_json"`
	StepType       *string `json:"step_type"`
	Enabled        *bool   `json:"enabled"`
	Dtstart        *string `json:"dtstart"`
	Timezone       *string `json:"timezone"`
}

func updateStringField(v *string) *wrapperspb.StringValue {
	if v == nil {
		return nil
	}
	return wrapperspb.String(*v)
}

func handleUpdateAutomation(client automationv1.AutomationServiceClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		identity, _ := identityFromContext(r.Context())
		automationID := chi.URLParam(r, "id")

		var body updateAutomationRequestBody
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSONError(w, http.StatusBadRequest, "INVALID_ARGUMENT", "invalid JSON body: "+err.Error())
			return
		}

		req := &automationv1.UpdateAutomationRequest{
			Id:             automationID,
			TenantId:       identity.TenantID,
			Name:           updateStringField(body.Name),
			Rrule:          updateStringField(body.RRule),
			StepConfigJson: updateStringField(body.StepConfigJSON),
			Dtstart:        updateStringField(body.Dtstart),
			Timezone:       updateStringField(body.Timezone),
		}
		if body.StepType != nil {
			req.StepType = parseStepType(*body.StepType)
		}
		if body.Enabled != nil {
			req.Enabled = wrapperspb.Bool(*body.Enabled)
		}

		ctx := gatewaygrpc.AttachIdentity(r.Context(), identity)
		resp, err := client.UpdateAutomation(ctx, req)
		if err != nil {
			writeGRPCError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, resp.GetAutomation())
	}
}

func handleDeleteAutomation(client automationv1.AutomationServiceClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		identity, _ := identityFromContext(r.Context())
		automationID := chi.URLParam(r, "id")

		ctx := gatewaygrpc.AttachIdentity(r.Context(), identity)
		_, err := client.DeleteAutomation(ctx, &automationv1.DeleteAutomationRequest{
			Id:       automationID,
			TenantId: identity.TenantID,
		})
		if err != nil {
			writeGRPCError(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// createAutomationRequestBody is the REST request shape for POST
// /v1/automations — tenant_id is deliberately absent: it comes from the
// validated Identity, never trusted from the request body, per
// api-gateway.md §9.
type createAutomationRequestBody struct {
	Name           string `json:"name"`
	RRule          string `json:"rrule"`
	StepConfigJSON string `json:"step_config_json"`
	StepType       string `json:"step_type"`
	Dtstart        string `json:"dtstart"`
	Timezone       string `json:"timezone"`
}

func handleCreateAutomation(client automationv1.AutomationServiceClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		identity, _ := identityFromContext(r.Context())

		var body createAutomationRequestBody
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSONError(w, http.StatusBadRequest, "INVALID_ARGUMENT", "invalid JSON body: "+err.Error())
			return
		}

		ctx := gatewaygrpc.AttachIdentity(r.Context(), identity)
		resp, err := client.CreateAutomation(ctx, &automationv1.CreateAutomationRequest{
			TenantId:       identity.TenantID,
			Name:           body.Name,
			Rrule:          body.RRule,
			StepConfigJson: body.StepConfigJSON,
			StepType:       parseStepType(body.StepType),
			Dtstart:        body.Dtstart,
			Timezone:       body.Timezone,
		})
		if err != nil {
			writeGRPCError(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, resp.GetAutomation())
	}
}

// runNowRequestBody is the REST request shape for POST
// /v1/automations/{id}/run.
type runNowRequestBody struct {
	RequestID string `json:"request_id"`
}

func handleRunNow(client automationv1.AutomationServiceClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		identity, _ := identityFromContext(r.Context())
		automationID := chi.URLParam(r, "id")

		var body runNowRequestBody
		if r.Body != nil && r.ContentLength != 0 {
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				writeJSONError(w, http.StatusBadRequest, "INVALID_ARGUMENT", "invalid JSON body: "+err.Error())
				return
			}
		}

		ctx := gatewaygrpc.AttachIdentity(r.Context(), identity)
		resp, err := client.RunNow(ctx, &automationv1.RunNowRequest{
			AutomationId: automationID,
			RequestId:    body.RequestID,
		})
		if err != nil {
			writeGRPCError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, resp.GetRun())
	}
}

func handleListRuns(client automationv1.AutomationServiceClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// ListRuns has no tenant_id field; identity still flows via
		// AttachIdentity below so automation-service can scope automation_id
		// ownership to the caller's tenant.
		identity, _ := identityFromContext(r.Context())
		automationID := chi.URLParam(r, "id")
		q := r.URL.Query()

		var pageSize int32
		if v := q.Get("page_size"); v != "" {
			n, err := strconv.ParseInt(v, 10, 32)
			if err != nil {
				writeJSONError(w, http.StatusBadRequest, "INVALID_ARGUMENT", "page_size must be an integer")
				return
			}
			pageSize = int32(n)
		}

		ctx := gatewaygrpc.AttachIdentity(r.Context(), identity)
		resp, err := client.ListRuns(ctx, &automationv1.ListRunsRequest{
			AutomationId: automationID,
			PageToken:    q.Get("page_token"),
			PageSize:     pageSize,
		})
		if err != nil {
			writeGRPCError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, resp)
	}
}

// handleExternalTriggerRequestBody is the REST request shape for POST
// /v1/automations/{id}/trigger.
type handleExternalTriggerRequestBody struct {
	RequestID   string `json:"request_id"`
	PayloadJSON string `json:"payload_json"`
}

func handleHandleExternalTrigger(client automationv1.AutomationServiceClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// HandleExternalTrigger has no tenant_id field either; same reasoning
		// as ListRuns above.
		identity, _ := identityFromContext(r.Context())
		automationID := chi.URLParam(r, "id")

		var body handleExternalTriggerRequestBody
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSONError(w, http.StatusBadRequest, "INVALID_ARGUMENT", "invalid JSON body: "+err.Error())
			return
		}

		ctx := gatewaygrpc.AttachIdentity(r.Context(), identity)
		resp, err := client.HandleExternalTrigger(ctx, &automationv1.HandleExternalTriggerRequest{
			AutomationId: automationID,
			RequestId:    body.RequestID,
			PayloadJson:  body.PayloadJSON,
		})
		if err != nil {
			writeGRPCError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, resp.GetRun())
	}
}

// parseStepType accepts either the bare suffix (case-insensitive, e.g.
// "agent") or the full enum name (e.g. "STEP_TYPE_AGENT") — mirrors
// parseProvider's leniency in usage_routes.go.
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
