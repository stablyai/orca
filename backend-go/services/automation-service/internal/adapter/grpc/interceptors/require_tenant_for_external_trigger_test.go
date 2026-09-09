package interceptors

import (
	"context"
	"testing"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/stablyai/orca-go/common/tenant"

	automationv1 "github.com/stablyai/orca-go/proto/gen/go/orca/automation/v1"
)

func TestRequireTenantForExternalTrigger_ValidTenant_PassesThrough(t *testing.T) {
	interceptor := RequireTenantForExternalTrigger()
	ctx := tenant.WithTenantID(context.Background(), "tenant-1")
	info := &grpc.UnaryServerInfo{FullMethod: automationv1.AutomationService_HandleExternalTrigger_FullMethodName}
	called := false

	_, err := interceptor(ctx, "req", info, func(ctx context.Context, req any) (any, error) {
		called = true
		return "ok", nil
	})

	if err != nil {
		t.Fatalf("expected no error for a valid tenant, got %v", err)
	}
	if !called {
		t.Error("expected the handler to be called")
	}
}

func TestRequireTenantForExternalTrigger_NoTenant_RejectsBeforeHandler(t *testing.T) {
	interceptor := RequireTenantForExternalTrigger()
	info := &grpc.UnaryServerInfo{FullMethod: automationv1.AutomationService_HandleExternalTrigger_FullMethodName}
	called := false

	_, err := interceptor(context.Background(), "req", info, func(ctx context.Context, req any) (any, error) {
		called = true
		return "ok", nil
	})

	if err == nil {
		t.Fatal("expected an error for a request with no tenant identity")
	}
	if status.Code(err) != codes.PermissionDenied {
		t.Errorf("Code = %v, want PermissionDenied", status.Code(err))
	}
	if called {
		t.Error("handler must not be called — the interceptor must fail fast, before the usecase layer")
	}
}

func TestRequireTenantForExternalTrigger_OtherMethods_PassThroughUnchecked(t *testing.T) {
	interceptor := RequireTenantForExternalTrigger()
	info := &grpc.UnaryServerInfo{FullMethod: automationv1.AutomationService_RunNow_FullMethodName}
	called := false

	// No tenant in context at all — this gate must ONLY apply to
	// HandleExternalTrigger; every other RPC keeps relying on its own
	// usecase-layer tenant.RequireTenantID check, unaffected by this task.
	_, err := interceptor(context.Background(), "req", info, func(ctx context.Context, req any) (any, error) {
		called = true
		return "ok", nil
	})

	if err != nil {
		t.Fatalf("expected RunNow to pass through this interceptor untouched, got %v", err)
	}
	if !called {
		t.Error("expected the handler to be called for a non-gated method")
	}
}
