package usecase

import (
	"context"
	"errors"
	"testing"

	"github.com/stablyai/orca-go/services/infra-fleet-service/internal/domain"
)

// fakeEphemeralVmSshTargetRepository is an in-memory
// EphemeralVmSshTargetRepository — TestAgentOutboundSshProvisioner_CreatesRealConnectionRowWithProjectRoot
// and friends inspect upserted to confirm the audit row shape.
type fakeEphemeralVmSshTargetRepository struct {
	upserted []domain.EphemeralVmSshTargetRecord
}

func (f *fakeEphemeralVmSshTargetRepository) Upsert(ctx context.Context, record domain.EphemeralVmSshTargetRecord) (domain.EphemeralVmSshTargetRecord, error) {
	f.upserted = append(f.upserted, record)
	return record, nil
}

func (f *fakeEphemeralVmSshTargetRepository) Get(ctx context.Context, tenantID, runtimeID string) (domain.EphemeralVmSshTargetRecord, bool, error) {
	for _, r := range f.upserted {
		if r.TenantID == tenantID && r.RuntimeID == runtimeID {
			return r, true, nil
		}
	}
	return domain.EphemeralVmSshTargetRecord{}, false, nil
}

// TestAgentOutboundSshProvisioner_ForwardsIdentityFilePathRaw_NoVaultCall
// is TASK-BE-EVM-016's Gap 1 regression guard: the agent receives
// IdentityFilePath byte-for-byte, and this provisioner never touches Vault
// (no Vault collaborator even exists in its constructor anymore).
func TestAgentOutboundSshProvisioner_ForwardsIdentityFilePathRaw_NoVaultCall(t *testing.T) {
	agent := &fakeDevServerAgentClient{}
	conns := &fakeConnectionRepository{}
	records := &fakeEphemeralVmSshTargetRepository{}

	p := NewAgentOutboundSshProvisioner(agent, conns, records)

	sourceDevServer := domain.DevServer{ID: "ds-1"}
	target := domain.EphemeralVmSshTarget{
		Host: "10.0.0.5", Port: 22, Username: "orca",
		ProjectRoot:      "/vm/repo",
		IdentityFilePath: "/home/orca/.ssh/id_ed25519",
	}

	connectionID, err := p.Provision(withTenant(context.Background(), "tenant-1"), "tenant-1", "runtime-1", sourceDevServer, target)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if connectionID == "" {
		t.Error("expected a non-empty connectionID")
	}

	if len(agent.dialHiddenSshTargetCalls) != 1 {
		t.Fatalf("expected exactly 1 agent dial call, got %d", len(agent.dialHiddenSshTargetCalls))
	}
	dialed := agent.dialHiddenSshTargetCalls[0]
	if dialed.IdentityFilePath != "/home/orca/.ssh/id_ed25519" {
		t.Errorf("expected agent to receive the raw identityFile path unchanged, got %q", dialed.IdentityFilePath)
	}
	if dialed.PrivateKeyPEM != "" {
		t.Errorf("expected no resolved PEM material (Hướng A never resolves) — got %q", dialed.PrivateKeyPEM)
	}
	if dialed.Host != "10.0.0.5" || dialed.Username != "orca" {
		t.Errorf("expected host/username to pass through unchanged, got %+v", dialed)
	}
}

// TestAgentOutboundSshProvisioner_CreatesRealConnectionRowWithProjectRoot is
// TASK-BE-EVM-016's Gap 2 regression guard: Provision registers a real
// infra.connections row (via ConnectionRepository) keyed by
// sourceDevServer.ID + target.ProjectRoot, and returns ITS id — not a bare
// runtimeID convention.
func TestAgentOutboundSshProvisioner_CreatesRealConnectionRowWithProjectRoot(t *testing.T) {
	agent := &fakeDevServerAgentClient{}
	conns := &fakeConnectionRepository{}
	records := &fakeEphemeralVmSshTargetRepository{}

	p := NewAgentOutboundSshProvisioner(agent, conns, records)

	sourceDevServer := domain.DevServer{ID: "ds-42"}
	target := domain.EphemeralVmSshTarget{
		Host: "10.0.0.5", Port: 22, Username: "orca",
		ProjectRoot:      "/vm/repo",
		IdentityFilePath: "/home/orca/.ssh/id_ed25519",
	}

	connectionID, err := p.Provision(withTenant(context.Background(), "tenant-1"), "tenant-1", "runtime-1", sourceDevServer, target)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if len(conns.created) != 1 {
		t.Fatalf("expected exactly 1 connection row created, got %d", len(conns.created))
	}
	created := conns.created[0]
	if created.DevServerID != "ds-42" {
		t.Errorf("expected connection.DevServerID == sourceDevServer.ID, got %q", created.DevServerID)
	}
	if created.RepoPath != "/vm/repo" {
		t.Errorf("expected connection.RepoPath == target.ProjectRoot, got %q", created.RepoPath)
	}
	if created.TenantID != "tenant-1" {
		t.Errorf("expected connection.TenantID == tenant-1, got %q", created.TenantID)
	}
	if connectionID != created.ID {
		t.Errorf("expected returned connectionID (%q) to be the real created connection's id (%q)", connectionID, created.ID)
	}
	// Regression guard: no longer a bare runtimeID convention.
	if connectionID == "runtime-1" {
		t.Error("expected a real generated connectionID, not the runtimeID convention value")
	}
}

func TestAgentOutboundSshProvisioner_AuditRowNeverCarriesPrivateKeyPEM(t *testing.T) {
	agent := &fakeDevServerAgentClient{}
	conns := &fakeConnectionRepository{}
	records := &fakeEphemeralVmSshTargetRepository{}

	p := NewAgentOutboundSshProvisioner(agent, conns, records)

	target := domain.EphemeralVmSshTarget{
		Host: "10.0.0.5", Port: 22, Username: "orca",
		ProjectRoot:         "/vm/repo",
		IdentityFilePath:    "/home/orca/.ssh/id_ed25519",
		IdentityAgentSocket: "/tmp/ssh-agent.sock",
	}

	if _, err := p.Provision(withTenant(context.Background(), "tenant-1"), "tenant-1", "runtime-1", domain.DevServer{ID: "ds-1"}, target); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if len(records.upserted) != 1 {
		t.Fatalf("expected exactly 1 upserted audit row, got %d", len(records.upserted))
	}
	rec := records.upserted[0]
	// domain.EphemeralVmSshTargetRecord has no field a PEM value could even
	// be assigned to — nothing here to leak. This test guards the audit row
	// still records the (non-secret) paths actually dialed.
	if rec.IdentityFileVaultPath != "/home/orca/.ssh/id_ed25519" {
		t.Errorf("expected audit row to record the identity file path, got %q", rec.IdentityFileVaultPath)
	}
	if rec.IdentityAgentVaultPath != "/tmp/ssh-agent.sock" {
		t.Errorf("expected audit row to record the identity agent socket path, got %q", rec.IdentityAgentVaultPath)
	}
}

func TestAgentOutboundSshProvisioner_AgentDialFails_ReturnsError(t *testing.T) {
	agent := &fakeDevServerAgentClient{dialHiddenSshTargetErr: errors.New("agent rejected dial")}
	conns := &fakeConnectionRepository{}
	records := &fakeEphemeralVmSshTargetRepository{}

	p := NewAgentOutboundSshProvisioner(agent, conns, records)

	target := domain.EphemeralVmSshTarget{Host: "10.0.0.5", Port: 22, Username: "orca", ProjectRoot: "/vm/repo"}
	if _, err := p.Provision(withTenant(context.Background(), "tenant-1"), "tenant-1", "runtime-1", domain.DevServer{ID: "ds-1"}, target); err == nil {
		t.Fatal("expected an error when the agent rejects the dial")
	}
	if len(records.upserted) != 0 {
		t.Error("expected no audit row upserted when the dial itself failed")
	}
	if len(conns.created) != 0 {
		t.Error("expected no connection row created when the dial itself failed")
	}
}

func TestAgentOutboundSshProvisioner_CreateConnectionFails_ReturnsError(t *testing.T) {
	agent := &fakeDevServerAgentClient{}
	conns := &fakeConnectionRepository{err: errors.New("db unreachable")}
	records := &fakeEphemeralVmSshTargetRepository{}

	p := NewAgentOutboundSshProvisioner(agent, conns, records)

	target := domain.EphemeralVmSshTarget{Host: "10.0.0.5", Port: 22, Username: "orca", ProjectRoot: "/vm/repo"}
	if _, err := p.Provision(withTenant(context.Background(), "tenant-1"), "tenant-1", "runtime-1", domain.DevServer{ID: "ds-1"}, target); err == nil {
		t.Fatal("expected an error when creating the connection row fails")
	}
}

// TestAgentOutboundSshProvisioner_ThreadsKnownFingerprintOnRepeatDial is
// Hướng A's Gap 4 completion regression guard (found in the final
// cross-check after TASK-BE-EVM-019 shipped Hướng B's TOFU but Hướng A's
// Provision discarded DialHiddenSshTarget's fingerprint entirely): a
// second Provision call for the same runtimeID must forward the
// previously-recorded fingerprint as target.KnownHostKeyFingerprint, and
// persist whatever the agent echoes back on this dial.
func TestAgentOutboundSshProvisioner_ThreadsKnownFingerprintOnRepeatDial(t *testing.T) {
	agent := &fakeDevServerAgentClient{dialHiddenSshTargetFingerprint: "SHA256:second-dial"}
	conns := &fakeConnectionRepository{}
	records := &fakeEphemeralVmSshTargetRepository{
		upserted: []domain.EphemeralVmSshTargetRecord{
			{TenantID: "tenant-1", RuntimeID: "runtime-1", HostKeyFingerprint: "SHA256:first-dial"},
		},
	}
	p := NewAgentOutboundSshProvisioner(agent, conns, records)

	target := domain.EphemeralVmSshTarget{Host: "10.0.0.5", Port: 22, Username: "orca", ProjectRoot: "/vm/repo"}
	if _, err := p.Provision(withTenant(context.Background(), "tenant-1"), "tenant-1", "runtime-1", domain.DevServer{ID: "ds-1"}, target); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if len(agent.dialHiddenSshTargetCalls) != 1 {
		t.Fatalf("expected exactly 1 agent dial call, got %d", len(agent.dialHiddenSshTargetCalls))
	}
	if got := agent.dialHiddenSshTargetCalls[0].KnownHostKeyFingerprint; got != "SHA256:first-dial" {
		t.Errorf("expected the previously-recorded fingerprint forwarded to the agent, got %q", got)
	}
	if len(records.upserted) != 2 {
		t.Fatalf("expected a second upsert recording this dial, got %d", len(records.upserted))
	}
	if got := records.upserted[1].HostKeyFingerprint; got != "SHA256:second-dial" {
		t.Errorf("expected the agent's newly-echoed fingerprint persisted, got %q", got)
	}
}

// TestAgentOutboundSshProvisioner_AgentOmitsFingerprint_PreservesPrevious
// guards the defensive fallback: an agent build too old to echo
// hostKeyFingerprint back must never silently erase a fingerprint a prior
// dial already recorded (Upsert is a full replace, not a partial merge —
// erasing it here would make the NEXT dial's TOFU check wrongly see
// "first use" again).
func TestAgentOutboundSshProvisioner_AgentOmitsFingerprint_PreservesPrevious(t *testing.T) {
	agent := &fakeDevServerAgentClient{} // dialHiddenSshTargetFingerprint left empty — simulates an old agent build
	conns := &fakeConnectionRepository{}
	records := &fakeEphemeralVmSshTargetRepository{
		upserted: []domain.EphemeralVmSshTargetRecord{
			{TenantID: "tenant-1", RuntimeID: "runtime-1", HostKeyFingerprint: "SHA256:must-survive"},
		},
	}
	p := NewAgentOutboundSshProvisioner(agent, conns, records)

	target := domain.EphemeralVmSshTarget{Host: "10.0.0.5", Port: 22, Username: "orca", ProjectRoot: "/vm/repo"}
	if _, err := p.Provision(withTenant(context.Background(), "tenant-1"), "tenant-1", "runtime-1", domain.DevServer{ID: "ds-1"}, target); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if len(records.upserted) != 2 {
		t.Fatalf("expected a second upsert, got %d", len(records.upserted))
	}
	if got := records.upserted[1].HostKeyFingerprint; got != "SHA256:must-survive" {
		t.Errorf("expected the previous fingerprint preserved when the agent omits one, got %q", got)
	}
}
