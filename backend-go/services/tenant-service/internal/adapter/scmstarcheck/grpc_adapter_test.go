package scmstarcheck

import (
	"context"
	"errors"
	"testing"

	"google.golang.org/grpc"

	scmintegrationv1 "github.com/stablyai/orca-go/proto/gen/go/orca/scmintegration/v1"

	"github.com/stablyai/orca-go/common/tenant"
)

// fakeScmIntegrationClient is a minimal test double for
// scmintegrationv1.ScmIntegrationServiceClient — embeds the nil interface,
// overrides only StarRepository.
type fakeScmIntegrationClient struct {
	scmintegrationv1.ScmIntegrationServiceClient

	starRepositoryFunc func(ctx context.Context, in *scmintegrationv1.StarRepositoryRequest) (*scmintegrationv1.StarRepositoryResponse, error)
}

func (f *fakeScmIntegrationClient) StarRepository(ctx context.Context, in *scmintegrationv1.StarRepositoryRequest, _ ...grpc.CallOption) (*scmintegrationv1.StarRepositoryResponse, error) {
	return f.starRepositoryFunc(ctx, in)
}

func TestGrpcAdapter_StarRepository_Success(t *testing.T) {
	var gotReq *scmintegrationv1.StarRepositoryRequest
	fake := &fakeScmIntegrationClient{
		starRepositoryFunc: func(ctx context.Context, in *scmintegrationv1.StarRepositoryRequest) (*scmintegrationv1.StarRepositoryResponse, error) {
			gotReq = in
			return &scmintegrationv1.StarRepositoryResponse{Starred: true}, nil
		},
	}
	adapter := NewGrpcAdapter(fake)
	ctx := tenant.WithTenantID(context.Background(), "tenant-1")

	starred, ok := adapter.StarRepository(ctx, "user-1")
	if !ok || !starred {
		t.Errorf("expected (true, true), got (%v, %v)", starred, ok)
	}
	if gotReq.GetTenantId() != "tenant-1" {
		t.Errorf("expected TenantId=tenant-1, got %q", gotReq.GetTenantId())
	}
	if gotReq.GetProvider() != scmintegrationv1.ScmProvider_SCM_PROVIDER_GITHUB {
		t.Errorf("expected GitHub provider, got %v", gotReq.GetProvider())
	}
	if gotReq.GetRepo() != orcaRepoSlug {
		t.Errorf("expected repo=%q, got %q", orcaRepoSlug, gotReq.GetRepo())
	}
}

func TestGrpcAdapter_StarRepository_RPCErrorDegradesToNotOK(t *testing.T) {
	fake := &fakeScmIntegrationClient{
		starRepositoryFunc: func(ctx context.Context, in *scmintegrationv1.StarRepositoryRequest) (*scmintegrationv1.StarRepositoryResponse, error) {
			return nil, errors.New("boom")
		},
	}
	adapter := NewGrpcAdapter(fake)
	ctx := tenant.WithTenantID(context.Background(), "tenant-1")

	starred, ok := adapter.StarRepository(ctx, "user-1")
	if ok || starred {
		t.Errorf("expected (false, false) on RPC error, got (%v, %v)", starred, ok)
	}
}

func TestGrpcAdapter_StarRepository_NoTenantInContextDegradesToNotOK(t *testing.T) {
	adapter := NewGrpcAdapter(&fakeScmIntegrationClient{})

	starred, ok := adapter.StarRepository(context.Background(), "user-1")
	if ok || starred {
		t.Errorf("expected (false, false) with no tenant in context, got (%v, %v)", starred, ok)
	}
}

func TestGrpcAdapter_CheckStarred_AlwaysDegradesToNotOK(t *testing.T) {
	// No CheckRepositoryStarred RPC exists yet (confirmed against the real
	// merged scmintegration.proto) — this must never call StarRepository
	// (which would perform a real, unwanted star action as a side effect
	// of a "check").
	called := false
	fake := &fakeScmIntegrationClient{
		starRepositoryFunc: func(ctx context.Context, in *scmintegrationv1.StarRepositoryRequest) (*scmintegrationv1.StarRepositoryResponse, error) {
			called = true
			return &scmintegrationv1.StarRepositoryResponse{Starred: true}, nil
		},
	}
	adapter := NewGrpcAdapter(fake)

	starred, ok := adapter.CheckStarred(context.Background(), "user-1")
	if ok || starred {
		t.Errorf("expected (false, false), got (%v, %v)", starred, ok)
	}
	if called {
		t.Error("CheckStarred must never call StarRepository as a side effect")
	}
}
