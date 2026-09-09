package usecase

import (
	"context"
	"testing"

	"google.golang.org/grpc"
	"google.golang.org/protobuf/types/known/emptypb"

	"github.com/stablyai/orca-go/common/auditclient"
	"github.com/stablyai/orca-go/services/infra-fleet-service/internal/domain"

	authv1 "github.com/stablyai/orca-go/proto/gen/go/orca/auth/v1"
)

// fakeAuthServiceClient stubs AppendAuditEntry only — every other
// AuthServiceClient method is left nil-embedded and unused, mirroring
// common/auditclient/client_test.go's own fake.
type fakeAuthServiceClient struct {
	authv1.AuthServiceClient
	calls   int
	lastReq *authv1.AppendAuditEntryRequest
}

func (f *fakeAuthServiceClient) AppendAuditEntry(_ context.Context, in *authv1.AppendAuditEntryRequest, _ ...grpc.CallOption) (*emptypb.Empty, error) {
	f.calls++
	f.lastReq = in
	return &emptypb.Empty{}, nil
}

func TestEstablishConnection_HealthGatesResult(t *testing.T) {
	t.Run("healthy agent establishes connection", func(t *testing.T) {
		sshTargets := &fakeSshTargetRepository{single: domain.SshTarget{ID: "s1", TenantID: "t1", Host: "h1"}}
		devServers := &fakeDevServerRepository{found: false}
		conns := &fakeConnectionRepository{}
		agent := &fakeDevServerAgentClient{healthy: true}
		uc := NewEstablishConnection(sshTargets, devServers, conns, agent, nil)

		conn, err := uc.Execute(withTenant(context.Background(), "t1"), EstablishConnectionInput{SshTargetID: "s1"})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if conn.Status != "established" {
			t.Errorf("got status %q, want established", conn.Status)
		}
		if !devServers.registerCalled || devServers.lastRegistered.Mode != domain.ConnectionModeRelaySSH {
			t.Error("expected a relay-ssh-mode DevServer to be registered")
		}
	})

	t.Run("unreachable agent fails", func(t *testing.T) {
		sshTargets := &fakeSshTargetRepository{single: domain.SshTarget{ID: "s1", TenantID: "t1", Host: "h1"}}
		devServers := &fakeDevServerRepository{found: false}
		conns := &fakeConnectionRepository{}
		agent := &fakeDevServerAgentClient{healthy: false}
		uc := NewEstablishConnection(sshTargets, devServers, conns, agent, nil)

		_, err := uc.Execute(withTenant(context.Background(), "t1"), EstablishConnectionInput{SshTargetID: "s1"})
		if err == nil {
			t.Fatal("expected error when agent is unreachable")
		}
	})

	t.Run("existing dev server binding is reused, not re-registered", func(t *testing.T) {
		sshTargets := &fakeSshTargetRepository{single: domain.SshTarget{ID: "s1", TenantID: "t1", Host: "h1"}}
		devServers := &fakeDevServerRepository{found: true, bySshTarget: domain.DevServer{ID: "ds1", TenantID: "t1", Host: "h1", Mode: domain.ConnectionModeRelaySSH, SSHTargetID: "s1"}}
		conns := &fakeConnectionRepository{}
		agent := &fakeDevServerAgentClient{healthy: true}
		uc := NewEstablishConnection(sshTargets, devServers, conns, agent, nil)

		conn, err := uc.Execute(withTenant(context.Background(), "t1"), EstablishConnectionInput{SshTargetID: "s1"})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if conn.DevServerID != "ds1" {
			t.Errorf("expected the existing dev server to be reused, got %q", conn.DevServerID)
		}
		if devServers.registerCalled {
			t.Error("expected no new DevServer to be registered when one is already bound")
		}
	})
}

func TestEstablishConnection_RequiresTenantContext(t *testing.T) {
	uc := NewEstablishConnection(&fakeSshTargetRepository{}, &fakeDevServerRepository{}, &fakeConnectionRepository{}, &fakeDevServerAgentClient{}, nil)
	_, err := uc.Execute(context.Background(), EstablishConnectionInput{SshTargetID: "s1"})
	if err == nil {
		t.Fatal("expected an error when no tenant is in context")
	}
}

// --- TASK-BE-022: audit-append (action="ssh.connect") on both allow and
// deny branches ---

func TestEstablishConnection_UnreachableAgentAppendsExactlyOneDeniedAuditEntry(t *testing.T) {
	sshTargets := &fakeSshTargetRepository{single: domain.SshTarget{ID: "s1", TenantID: "t1", Host: "h1"}}
	devServers := &fakeDevServerRepository{found: false}
	conns := &fakeConnectionRepository{}
	agent := &fakeDevServerAgentClient{healthy: false}
	fake := &fakeAuthServiceClient{}
	uc := NewEstablishConnection(sshTargets, devServers, conns, agent, auditclient.New(fake))

	ctx := withTenantAndUser(context.Background(), "t1", "user-1")
	if _, err := uc.Execute(ctx, EstablishConnectionInput{SshTargetID: "s1"}); err == nil {
		t.Fatal("expected error when agent is unreachable")
	}
	if fake.calls != 1 {
		t.Fatalf("expected exactly one AppendAuditEntry call, got %d", fake.calls)
	}
	if fake.lastReq.GetAction() != "ssh.connect" {
		t.Fatalf("expected action %q, got %q", "ssh.connect", fake.lastReq.GetAction())
	}
	if fake.lastReq.GetOutcome() != "denied" {
		t.Fatalf("expected outcome %q, got %q", "denied", fake.lastReq.GetOutcome())
	}
	if fake.lastReq.GetActorId() != "user-1" {
		t.Fatalf("expected actor_id %q, got %q", "user-1", fake.lastReq.GetActorId())
	}
}

func TestEstablishConnection_HealthyAgentAppendsExactlyOneAllowedAuditEntry(t *testing.T) {
	sshTargets := &fakeSshTargetRepository{single: domain.SshTarget{ID: "s1", TenantID: "t1", Host: "h1"}}
	devServers := &fakeDevServerRepository{found: false}
	conns := &fakeConnectionRepository{}
	agent := &fakeDevServerAgentClient{healthy: true}
	fake := &fakeAuthServiceClient{}
	uc := NewEstablishConnection(sshTargets, devServers, conns, agent, auditclient.New(fake))

	ctx := withTenantAndUser(context.Background(), "t1", "user-1")
	conn, err := uc.Execute(ctx, EstablishConnectionInput{SshTargetID: "s1"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if fake.calls != 1 {
		t.Fatalf("expected exactly one AppendAuditEntry call, got %d", fake.calls)
	}
	if fake.lastReq.GetOutcome() != "allowed" {
		t.Fatalf("expected outcome %q, got %q", "allowed", fake.lastReq.GetOutcome())
	}
	if fake.lastReq.GetTarget() != "devserver:"+conn.DevServerID {
		t.Fatalf("expected target %q, got %q", "devserver:"+conn.DevServerID, fake.lastReq.GetTarget())
	}
}

// TestEstablishConnection_NilAuditClientIsANoOp proves the auditClient is
// optional (every test above except the two audit-specific ones never wires
// one) and never panics.
func TestEstablishConnection_NilAuditClientIsANoOp(t *testing.T) {
	sshTargets := &fakeSshTargetRepository{single: domain.SshTarget{ID: "s1", TenantID: "t1", Host: "h1"}}
	devServers := &fakeDevServerRepository{found: false}
	conns := &fakeConnectionRepository{}
	agent := &fakeDevServerAgentClient{healthy: true}
	uc := NewEstablishConnection(sshTargets, devServers, conns, agent, nil)

	ctx := withTenantAndUser(context.Background(), "t1", "user-1")
	if _, err := uc.Execute(ctx, EstablishConnectionInput{SshTargetID: "s1"}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}
