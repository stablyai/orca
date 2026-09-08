package wscompat

import (
	"context"
	"testing"

	"google.golang.org/protobuf/types/known/emptypb"

	tenantv1 "github.com/stablyai/orca-go/proto/gen/go/orca/tenant/v1"
)

func TestStarNagDismissChannel_Success(t *testing.T) {
	var gotReq *tenantv1.DismissStarNagRequest
	fake := &fakeTenantServiceClient{
		dismissStarNagFunc: func(ctx context.Context, in *tenantv1.DismissStarNagRequest) (*emptypb.Empty, error) {
			gotReq = in
			return &emptypb.Empty{}, nil
		},
	}
	r := NewRegistry()
	registerStarNagChannels(r, fake)

	_, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1", UserID: "user-1"}, "starNag.dismiss", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if gotReq.GetUserId() != "user-1" {
		t.Errorf("expected UserId=user-1, got %q", gotReq.GetUserId())
	}
}

func TestStarNagLaterChannel_CallsDeferStarNag(t *testing.T) {
	var called bool
	fake := &fakeTenantServiceClient{
		deferStarNagFunc: func(ctx context.Context, in *tenantv1.DeferStarNagRequest) (*emptypb.Empty, error) {
			called = true
			return &emptypb.Empty{}, nil
		},
	}
	r := NewRegistry()
	registerStarNagChannels(r, fake)

	if _, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1", UserID: "user-1"}, "starNag.later", nil); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !called {
		t.Error("expected DeferStarNag to be called")
	}
}

func TestStarNagCompleteChannel_Success(t *testing.T) {
	fake := &fakeTenantServiceClient{
		completeStarNagFunc: func(ctx context.Context, in *tenantv1.CompleteStarNagRequest) (*emptypb.Empty, error) {
			return &emptypb.Empty{}, nil
		},
	}
	r := NewRegistry()
	registerStarNagChannels(r, fake)
	if _, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1", UserID: "user-1"}, "starNag.complete", nil); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestStarNagDisableChannel_Success(t *testing.T) {
	fake := &fakeTenantServiceClient{
		disableStarNagFunc: func(ctx context.Context, in *tenantv1.DisableStarNagRequest) (*emptypb.Empty, error) {
			return &emptypb.Empty{}, nil
		},
	}
	r := NewRegistry()
	registerStarNagChannels(r, fake)
	if _, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1", UserID: "user-1"}, "starNag.disable", nil); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestStarNagForceShowChannel_Success(t *testing.T) {
	fake := &fakeTenantServiceClient{
		forceShowStarNagFunc: func(ctx context.Context, in *tenantv1.ForceShowStarNagRequest) (*emptypb.Empty, error) {
			return &emptypb.Empty{}, nil
		},
	}
	r := NewRegistry()
	registerStarNagChannels(r, fake)
	if _, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1", UserID: "user-1"}, "starNag.forceShow", nil); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestStarNagOnboardingCompletedChannel_Success(t *testing.T) {
	fake := &fakeTenantServiceClient{
		notifyStarNagOnboardingCompletedFunc: func(ctx context.Context, in *tenantv1.NotifyStarNagOnboardingCompletedRequest) (*emptypb.Empty, error) {
			return &emptypb.Empty{}, nil
		},
	}
	r := NewRegistry()
	registerStarNagChannels(r, fake)
	if _, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1", UserID: "user-1"}, "starNag.onboardingCompleted", nil); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestStarNagOpenWebChannel_Success(t *testing.T) {
	fake := &fakeTenantServiceClient{
		openWebStarNagFunc: func(ctx context.Context, in *tenantv1.OpenWebStarNagRequest) (*emptypb.Empty, error) {
			return &emptypb.Empty{}, nil
		},
	}
	r := NewRegistry()
	registerStarNagGitHubChannels(r, fake)
	if _, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1", UserID: "user-1"}, "starNag.openWeb", nil); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestStarNagStarOrcaChannel_ReturnsStarredBool(t *testing.T) {
	fake := &fakeTenantServiceClient{
		starOrcaFromNagFunc: func(ctx context.Context, in *tenantv1.StarOrcaFromNagRequest) (*tenantv1.StarOrcaFromNagResponse, error) {
			return &tenantv1.StarOrcaFromNagResponse{Starred: true}, nil
		},
	}
	r := NewRegistry()
	registerStarNagGitHubChannels(r, fake)
	result, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1", UserID: "user-1"}, "starNag.starOrca", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	starred, ok := result.(bool)
	if !ok || !starred {
		t.Errorf("expected starred=true, got %+v", result)
	}
}

func TestStarNagAgentValueMomentChannel_DecodesAppVersionWhenPresent(t *testing.T) {
	var gotReq *tenantv1.PrepareStarNagAgentValueMomentRequest
	fake := &fakeTenantServiceClient{
		prepareStarNagAgentValueMomentFunc: func(ctx context.Context, in *tenantv1.PrepareStarNagAgentValueMomentRequest) (*tenantv1.StarNagAgentValueMomentPreparation, error) {
			gotReq = in
			return &tenantv1.StarNagAgentValueMomentPreparation{Status: "ready", Mode: "web"}, nil
		},
	}
	r := NewRegistry()
	registerStarNagGitHubChannels(r, fake)

	args := argsJSON(t, map[string]string{"appVersion": "1.2.3"})
	result, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1", UserID: "user-1"}, "starNag.agentValueMoment", args)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if gotReq.GetAppVersion() != "1.2.3" {
		t.Errorf("expected AppVersion=1.2.3, got %q", gotReq.GetAppVersion())
	}
	m, ok := result.(map[string]string)
	if !ok || m["status"] != "ready" || m["mode"] != "web" {
		t.Errorf("unexpected result: %+v", result)
	}
}

func TestStarNagAgentValueMomentChannel_EmptyArgsStillWorks(t *testing.T) {
	// Confirmed real-world case: the frontend's actual call site
	// (runtime-star-nag-client.ts's prepareRuntimeStarNagAgentValueMoment)
	// sends an empty params object, no appVersion field at all.
	var gotReq *tenantv1.PrepareStarNagAgentValueMomentRequest
	fake := &fakeTenantServiceClient{
		prepareStarNagAgentValueMomentFunc: func(ctx context.Context, in *tenantv1.PrepareStarNagAgentValueMomentRequest) (*tenantv1.StarNagAgentValueMomentPreparation, error) {
			gotReq = in
			return &tenantv1.StarNagAgentValueMomentPreparation{Status: "skipped"}, nil
		},
	}
	r := NewRegistry()
	registerStarNagGitHubChannels(r, fake)

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1", UserID: "user-1"}, "starNag.agentValueMoment", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if gotReq.GetAppVersion() != "" {
		t.Errorf("expected empty AppVersion when args are absent, got %q", gotReq.GetAppVersion())
	}
	m, ok := result.(map[string]string)
	if !ok || m["status"] != "skipped" {
		t.Errorf("unexpected result: %+v", result)
	}
}

func TestStarNagShowAgentValueMomentChannel_Success(t *testing.T) {
	fake := &fakeTenantServiceClient{
		showPreparedStarNagAgentValueMomentFunc: func(ctx context.Context, in *tenantv1.ShowPreparedStarNagAgentValueMomentRequest) (*emptypb.Empty, error) {
			return &emptypb.Empty{}, nil
		},
	}
	r := NewRegistry()
	registerStarNagGitHubChannels(r, fake)
	if _, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1", UserID: "user-1"}, "starNag.showAgentValueMoment", nil); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}
