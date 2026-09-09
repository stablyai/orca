package grpcmw

import (
	"context"
	"testing"

	"google.golang.org/grpc"
	"google.golang.org/grpc/metadata"

	"github.com/stablyai/orca-go/common/tenant"
)

func TestTenantExtractionInterceptor_AttachesRoleWhenPresent(t *testing.T) {
	md := metadata.Pairs(MetadataTenantID, "t1", MetadataUserID, "u1", MetadataRole, "admin")
	ctx := metadata.NewIncomingContext(context.Background(), md)

	interceptor := TenantExtractionInterceptor()
	var gotCtx context.Context
	handler := func(ctx context.Context, req any) (any, error) {
		gotCtx = ctx
		return nil, nil
	}
	if _, err := interceptor(ctx, nil, &grpc.UnaryServerInfo{}, handler); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if v, ok := tenant.Role(gotCtx); !ok || v != "admin" {
		t.Errorf("want role=\"admin\", got (%q, %v)", v, ok)
	}
	if v, ok := tenant.TenantID(gotCtx); !ok || v != "t1" {
		t.Errorf("want tenant_id=\"t1\", got (%q, %v)", v, ok)
	}
}

// TestTenantExtractionInterceptor_AttachesClientIPWhenPresent mirrors
// TestTenantExtractionInterceptor_AttachesRoleWhenPresent for
// MetadataClientIP/tenant.ClientIP (TASK-BE-023/CR-RBAC-005).
func TestTenantExtractionInterceptor_AttachesClientIPWhenPresent(t *testing.T) {
	md := metadata.Pairs(MetadataTenantID, "t1", MetadataUserID, "u1", MetadataClientIP, "203.0.113.7")
	ctx := metadata.NewIncomingContext(context.Background(), md)

	interceptor := TenantExtractionInterceptor()
	var gotCtx context.Context
	handler := func(ctx context.Context, req any) (any, error) {
		gotCtx = ctx
		return nil, nil
	}
	if _, err := interceptor(ctx, nil, &grpc.UnaryServerInfo{}, handler); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if v, ok := tenant.ClientIP(gotCtx); !ok || v != "203.0.113.7" {
		t.Errorf("want client_ip=\"203.0.113.7\", got (%q, %v)", v, ok)
	}
}

// TestTenantExtractionInterceptor_MissingClientIPLeavesItAbsent guards the
// same backward-compatibility contract as
// TestTenantExtractionInterceptor_MissingRoleLeavesItAbsent, for
// MetadataClientIP.
func TestTenantExtractionInterceptor_MissingClientIPLeavesItAbsent(t *testing.T) {
	md := metadata.Pairs(MetadataTenantID, "t1", MetadataUserID, "u1")
	ctx := metadata.NewIncomingContext(context.Background(), md)

	interceptor := TenantExtractionInterceptor()
	var gotCtx context.Context
	handler := func(ctx context.Context, req any) (any, error) {
		gotCtx = ctx
		return nil, nil
	}
	if _, err := interceptor(ctx, nil, &grpc.UnaryServerInfo{}, handler); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if v, ok := tenant.ClientIP(gotCtx); ok || v != "" {
		t.Errorf("want client_ip absent, got (%q, %v)", v, ok)
	}
}

// TestTenantExtractionInterceptor_MissingRoleLeavesItAbsent guards backward
// compatibility: a caller that never sends x-orca-role (every existing
// caller, before CR-DS-006 Phase 2) must not have a role fabricated for it.
func TestTenantExtractionInterceptor_MissingRoleLeavesItAbsent(t *testing.T) {
	md := metadata.Pairs(MetadataTenantID, "t1", MetadataUserID, "u1")
	ctx := metadata.NewIncomingContext(context.Background(), md)

	interceptor := TenantExtractionInterceptor()
	var gotCtx context.Context
	handler := func(ctx context.Context, req any) (any, error) {
		gotCtx = ctx
		return nil, nil
	}
	if _, err := interceptor(ctx, nil, &grpc.UnaryServerInfo{}, handler); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if v, ok := tenant.Role(gotCtx); ok || v != "" {
		t.Errorf("want role absent, got (%q, %v)", v, ok)
	}
}
